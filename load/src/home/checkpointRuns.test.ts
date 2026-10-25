import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveLocalRun } from '../archive/index.ts';
import { rebuildRun } from '../rebuild/index.ts';
import { LAYOUT, type Report, readManifest } from '../records/index.ts';
import { expectedSourcesOf } from './homeRun.ts';

/**
 * Two runs shaped like the ones the first smoke raise on aws-prod left, each
 * archived and then rebuilt. In the first, one generator was stopped by hand
 * and another was taken back by Spot, and each was replaced. In the second,
 * the operator pressed Ctrl-C. Every generator spent time getting started
 * before its ramp began, and ECS recorded each stop well after the generator
 * had been told to stop.
 */
const STARTED = '2026-10-19T23:44:49.000Z';
const at = (seconds: number) => new Date(Date.parse(STARTED) + seconds * 1_000).toISOString();

const put = (folder: string, path: string, content: string) => {
  mkdirSync(dirname(join(folder, path)), { recursive: true });
  writeFileSync(join(folder, path), content);
};
const lines = (records: readonly object[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join('');
const everyTenSeconds = (from: number, to: number) =>
  Array.from({ length: Math.floor((to - from) / 10) + 1 }, (_, index) => from + index * 10);

type Run = {
  attempts: Attempt[];
  endsAt: number;
  outcome: 'finished' | 'interrupted';
  /** How long after the run's end the backend went on recording, in seconds; none when absent. */
  drainSeconds?: number;
};

/** One try at running a generator's slice, in seconds into the run. */
type Attempt = {
  generator: number;
  attempt: number;
  /** When its task was up, before it could begin. */
  launchedAt: number;
  /** When its ramp began, which can be after its task was up. */
  rampStart: number;
  rampEnd: number;
  /** When it was told to stop, if it was; otherwise it ran to `plannedEnd`. */
  toldToStop: number | null;
  /** When ECS recorded its task as stopped, if it was stopped. */
  taskStopped: number | null;
  plannedEnd: number;
  /** Whether the end of the run stopped it. */
  withTheRun?: boolean;
  replacedBy?: number;
};

const firstUserOf = (a: Attempt) => a.generator * 3;
const endOf = (a: Attempt) => a.toldToStop ?? a.plannedEnd;

const request = (
  a: Attempt,
  user: number,
  kind: 'signin' | 'push' | 'chat',
  start: number,
  totalMs: number,
) =>
  `REQUEST ${JSON.stringify({
    run: 'run-1',
    generator: a.generator,
    attempt: a.attempt,
    user,
    kind,
    startedAt: at(start),
    firstByteMs: kind === 'push' ? 5 : 100,
    totalMs,
    status: 200,
    outcome: kind === 'chat' ? 'streamed' : kind === 'push' ? 'held' : 'ok',
    errorCode: null,
  })}`;

/** What one attempt printed: its requests, state lines and report, which names the phases it ran. */
function printed(a: Attempt) {
  const user = firstUserOf(a);
  const end = endOf(a);
  const body = [
    request(a, user, 'signin', a.rampStart + 1, 80),
    request(a, user, 'chat', a.rampStart + 3, 400),
    request(a, user, 'push', a.rampStart + 2, (end - a.rampStart - 2) * 1_000),
  ];
  const states = [...everyTenSeconds(a.rampStart + 5, end), end].map(
    (second) =>
      `STATE ${JSON.stringify({ run: 'run-1', generator: a.generator, attempt: a.attempt, at: at(second), usersSignedIn: 3, pushStreamsOpen: 3, chattersActive: 3 })}`,
  );
  const rampEnd = Math.min(a.rampEnd, end);
  const report: Report = {
    runId: 'run-1',
    generator: a.generator,
    attempt: a.attempt,
    startedAt: at(a.launchedAt),
    endedAt: at(end + 2),
    interrupted: a.toldToStop !== null,
    requests: { total: 3, byKind: { signin: 1, chat: 1, push: 1 } },
    phases: {
      ramp: { startedAt: at(a.rampStart), endedAt: at(rampEnd) },
      hold: { startedAt: at(rampEnd), endedAt: at(end) },
      rampDown: { startedAt: at(end), endedAt: at(end + 2) },
    },
  };
  return `${[...body, ...states, `REPORT ${JSON.stringify(report)}`].join('\n')}\n`;
}

function leaveRun(folder: string, run: Run) {
  const { attempts, endsAt, outcome } = run;
  const launched = attempts.map((a) => ({
    kind: 'generator-launched',
    at: at(a.launchedAt),
    generator: a.generator,
    attempt: a.attempt,
    firstUser: firstUserOf(a),
    userCount: 3,
    task: `task-${a.generator}${a.attempt}`,
    spot: true,
    planned: { rampEndsAt: at(a.rampEnd), holdEndsAt: at(a.plannedEnd) },
  }));
  const stopped = attempts.map((a) => ({
    kind: 'generator-stopped',
    at: at(a.taskStopped ?? a.plannedEnd),
    generator: a.generator,
    attempt: a.attempt,
    reason: a.toldToStop === null ? 'finished' : 'interrupted',
    detail: a.toldToStop === null ? null : 'UserInitiated: the task was stopped',
    toldToStopAt: a.toldToStop === null ? null : at(a.toldToStop),
    stoppedForRunEnd: a.withTheRun ?? false,
    replacedByAttempt: a.replacedBy ?? null,
  }));
  put(
    folder,
    LAYOUT.events,
    lines([
      { kind: 'run-started', at: STARTED },
      { kind: 'process-started', at: at(1), name: 'backend', task: 'pid-7' },
      ...launched,
      ...stopped,
      { kind: 'run-ended', at: at(endsAt), outcome },
    ]),
  );
  for (const a of attempts) put(folder, LAYOUT.generatorOutput(a.generator, a.attempt), printed(a));

  const seconds = everyTenSeconds(0, endsAt);
  const record = (appRecord: object) =>
    JSON.stringify({ level: 30, time: 1, pid: 7, hostname: 'h', appRecord, msg: 'app record' });
  put(
    folder,
    LAYOUT.processLog('backend'),
    `${[
      'listening',
      ...attempts.map(() =>
        record({
          kind: 'exchange',
          userId: 'u1',
          trigger: 'submit',
          arrivedAt: at(30),
          verdict: 'pass',
          verdictAfterMs: 40,
          firstTokenAfterMs: 300,
          endedAfterMs: 880,
          outcome: 'completed',
          errorCode: null,
          assistantMessageId: 'm2',
        }),
      ),
      record({
        kind: 'job',
        task: 'driftGateFoldTurn',
        jobId: '5',
        attempt: 1,
        queuedAt: at(31),
        startedAt: at(31),
        finishedAt: at(32),
        durationMs: 30,
        outcome: 'succeeded',
        errorClass: null,
        errorCode: null,
      }),
      ...seconds.map((second) =>
        record({ kind: 'state', at: at(second), pushStreamsOpen: 9, oldestJobWaitMs: 0 }),
      ),
      ...drainRecords(run, record),
    ].join('\n')}\n`,
  );
  put(
    folder,
    LAYOUT.hostSamples,
    lines(
      seconds.map((second) => ({
        at: at(second),
        cpuPercent: 3,
        perCorePercent: [3],
        memoryAvailableBytes: 1,
        memoryUsedPercent: 40,
        swapUsedBytes: 0,
        swapInBytes: 0,
        swapOutBytes: 0,
        loadAverage1: 0.4,
      })),
    ),
  );
}

/** What the backend recorded after the run's end: a last exchange, a job it was still working through, and its state. */
function drainRecords(run: Run, record: (appRecord: object) => string) {
  if (run.drainSeconds === undefined) return [];
  return [
    record({
      kind: 'exchange',
      userId: 'u1',
      trigger: 'submit',
      arrivedAt: at(run.endsAt + 60),
      verdict: 'pass',
      verdictAfterMs: 40,
      firstTokenAfterMs: 300,
      endedAfterMs: 880,
      outcome: 'completed',
      errorCode: null,
      assistantMessageId: 'm3',
    }),
    record({
      kind: 'job',
      task: 'driftGateFoldTurn',
      jobId: '6',
      attempt: 1,
      queuedAt: at(run.endsAt + 70),
      startedAt: at(run.endsAt + 100),
      finishedAt: at(run.endsAt + 101),
      durationMs: 30,
      outcome: 'succeeded',
      errorClass: null,
      errorCode: null,
    }),
    ...everyTenSeconds(run.endsAt + 10, run.endsAt + run.drainSeconds).map((second) =>
      record({ kind: 'state', at: at(second), pushStreamsOpen: 0, oldestJobWaitMs: 30_000 }),
    ),
  ];
}

async function archived(
  run: Run,
): Promise<{ folder: string; rebuilt: ReturnType<typeof rebuildRun> }> {
  const folder = mkdtempSync(join(tmpdir(), 'checkpoint-run-'));
  leaveRun(folder, run);
  await archiveLocalRun({
    folder,
    description: {
      runId: 'run-1',
      step: 'home-smoke',
      config: {},
      target: 'cubi-dev',
      loadPath: 'direct',
      images: {},
      commits: { app: { sha: 'a', dirty: false }, harness: { sha: 'a', dirty: false } },
      limits: {
        maxHostCpuPercent: 70,
        maxMemoryUsedPercent: 80,
        maxFirstByteP95Ms: 2_500,
        maxErrorShare: 0.01,
      },
      startedAt: STARTED,
      endedAt: at(run.endsAt),
      trailingEndsAt: run.drainSeconds === undefined ? null : at(run.endsAt + run.drainSeconds),
    },
    expected: expectedSourcesOf({ inference: 'real' }),
  });
  return { folder, rebuilt: rebuildRun(folder) };
}

const finishing = (generator: number): Attempt => ({
  generator,
  attempt: 1,
  launchedAt: 5,
  rampStart: 25,
  rampEnd: 30,
  toldToStop: null,
  taskStopped: null,
  plannedEnd: 250,
});

describe('a run in which a generator was stopped by hand and another taken back by Spot', () => {
  // Generator 2 was told to stop at 80 s and its task was recorded stopped at 115 s;
  // generator 0 was told at 160 s and recorded stopped at 205 s. Each replacement
  // brought its users back over a ramp.
  const run = {
    endsAt: 260,
    outcome: 'finished' as const,
    attempts: [
      { ...finishing(0), toldToStop: 160, taskStopped: 205, replacedBy: 2 },
      { ...finishing(0), attempt: 2, launchedAt: 205, rampStart: 208, rampEnd: 238 },
      finishing(1),
      { ...finishing(2), toldToStop: 80, taskStopped: 115, replacedBy: 2 },
      { ...finishing(2), attempt: 2, launchedAt: 115, rampStart: 118, rampEnd: 178 },
      finishing(3),
    ],
  };

  it('is sealed complete, though the stopped generators began well after their tasks did', async () => {
    const { folder } = await archived(run);

    const manifest = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    expect(manifest.seal).toMatchObject({ status: 'complete' });
  });

  it('passes, and names both gaps with the windows the slices were really down', async () => {
    const { rebuilt } = await archived(run);

    expect(rebuilt.verdict).toBe('pass');
    expect(rebuilt.verdictText).toContain(
      `| generator 2 | ${at(80)} | ${at(178)} | users 6 to 8 were down for 98 s`,
    );
    expect(rebuilt.verdictText).toContain(
      `| generator 0 | ${at(160)} | ${at(238)} | users 0 to 2 were down for 78 s`,
    );
  });

  it('leaves the slices that kept their generators out of the gaps', async () => {
    const { rebuilt } = await archived(run);

    expect(rebuilt.verdictText).not.toContain('| generator 1 |');
    expect(rebuilt.verdictText).not.toContain('| generator 3 |');
  });
});

describe('a run the operator interrupted with Ctrl-C', () => {
  // Every generator was told to stop at 60 s, ECS recorded the tasks stopped about
  // 40 s later, and the run was recorded as ended at 110 s.
  const interrupted = (generator: number): Attempt => ({
    ...finishing(generator),
    toldToStop: 60,
    taskStopped: 100,
    withTheRun: true,
  });
  const run = {
    endsAt: 110,
    outcome: 'interrupted' as const,
    attempts: [0, 1, 2, 3].map(interrupted),
  };

  it('is sealed complete, because each generator’s start is timed from its ramp', async () => {
    const { folder } = await archived(run);

    const manifest = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    expect(manifest.seal).toMatchObject({ status: 'complete' });
  });

  it('is held back only by having ended early, with no slice shown as down', async () => {
    const { rebuilt } = await archived(run);

    expect(rebuilt.reasons).toEqual(['the run ended early (interrupted)']);
    expect(rebuilt.verdictText).not.toContain('were down');
  });
});

describe('a run whose archive also kept the stretch after its end', () => {
  const run: Run = {
    endsAt: 260,
    outcome: 'finished',
    drainSeconds: 300,
    attempts: [0, 1, 2, 3].map(finishing),
  };

  it('is judged by the run alone: its counts leave out what the backend did afterwards', async () => {
    const { folder, rebuilt } = await archived(run);

    expect(rebuilt.verdict).toBe('pass');
    const summary = JSON.parse(readFileSync(join(folder, LAYOUT.summary), 'utf8'));
    expect(summary.app.exchanges.count).toBe(4);
    expect(summary.app.jobs.count).toBe(1);
  });

  it('is drawn in the metrics table, in the minutes after the run, and marked', async () => {
    const { folder } = await archived(run);

    const [header, ...rows] = readFileSync(join(folder, LAYOUT.metricsTable), 'utf8')
      .trimEnd()
      .split('\n')
      .map((row) => row.split('\t'));
    const column = (name: string): number => header?.indexOf(name) ?? -1;
    const marked = rows.filter((row) => row[column('after_run')] === '1');
    expect(header?.at(-1)).toBe('after_run');
    expect(marked.map((row) => row[0])).toEqual([
      '2026-10-19T23:50:00.000Z',
      '2026-10-19T23:51:00.000Z',
      '2026-10-19T23:52:00.000Z',
      '2026-10-19T23:53:00.000Z',
      '2026-10-19T23:54:00.000Z',
    ]);
    const drained = rows.filter((row) => row[column('app_exchanges')] === '1');
    expect(drained.map((row) => row[column('after_run')])).toEqual(['1']);
  });

  it('is marked as after the run in the report', async () => {
    const { folder } = await archived(run);

    expect(readFileSync(join(folder, LAYOUT.report), 'utf8')).toContain('after the run');
  });

  it('is left out of the table and the report of a run that kept none', async () => {
    const { folder } = await archived({ ...run, drainSeconds: undefined });

    expect(readFileSync(join(folder, LAYOUT.metricsTable), 'utf8')).not.toContain('after_run');
    expect(readFileSync(join(folder, LAYOUT.report), 'utf8')).not.toContain('class="after-run"');
  });
});

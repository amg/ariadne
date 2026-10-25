import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveLocalRun } from '../archive/index.ts';
import { rebuildRun } from '../rebuild/index.ts';
import { LAYOUT, type Report, readManifest } from '../records/index.ts';
import { expectedSourcesOf } from './homeRun.ts';

/**
 * A run in which one of four generators was told to stop mid-hold and was
 * replaced, as the run command leaves it: archived, then rebuilt.
 */
const STARTED = '2026-10-17T00:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(STARTED) + seconds * 1_000).toISOString();

const everyTenSeconds = (from: number, to: number) =>
  Array.from({ length: Math.floor((to - from) / 10) + 1 }, (_, index) => from + index * 10);

const put = (folder: string, path: string, content: string) => {
  mkdirSync(dirname(join(folder, path)), { recursive: true });
  writeFileSync(join(folder, path), content);
};
const lines = (records: readonly object[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join('');

type Attempt = {
  generator: number;
  attempt: number;
  firstUser: number;
  /** When it started, when it stopped, and when its users were all signed in, in seconds into the run. */
  from: number;
  to: number;
  rampEnd: number;
  stoppedBy: 'finished' | 'interrupted';
};

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

/** What one attempt prints: a sign-in, a push stream held to its end and a chat for its first user, state lines, and its report. */
function printed(a: Attempt) {
  const body = [
    request(a, a.firstUser, 'signin', a.from + 1, 80),
    request(a, a.firstUser, 'chat', a.from + 3, 400),
    request(a, a.firstUser, 'push', a.from + 2, (a.to - a.from - 2) * 1_000),
  ];
  const states = [...everyTenSeconds(a.from + 5, a.to), a.to].map(
    (second) =>
      `STATE ${JSON.stringify({ run: 'run-1', generator: a.generator, attempt: a.attempt, at: at(second), usersSignedIn: 3, pushStreamsOpen: 3, chattersActive: 3 })}`,
  );
  const interrupted = a.stoppedBy === 'interrupted';
  const report: Report = {
    runId: 'run-1',
    generator: a.generator,
    attempt: a.attempt,
    startedAt: at(a.from),
    endedAt: at(a.to),
    interrupted,
    requests: { total: 3, byKind: { signin: 1, chat: 1, push: 1 } },
    phases: interrupted
      ? null
      : {
          ramp: { startedAt: at(a.from), endedAt: at(a.rampEnd) },
          hold: { startedAt: at(a.rampEnd), endedAt: at(a.to) },
          rampDown: { startedAt: at(a.to), endedAt: at(a.to) },
        },
  };
  return `${[...body, ...states, `REPORT ${JSON.stringify(report)}`].join('\n')}\n`;
}

const attempts: Attempt[] = [
  { generator: 0, attempt: 1, firstUser: 0, from: 5, to: 130, rampEnd: 10, stoppedBy: 'finished' },
  {
    generator: 1,
    attempt: 1,
    firstUser: 3,
    from: 5,
    to: 60,
    rampEnd: 10,
    stoppedBy: 'interrupted',
  },
  {
    generator: 1,
    attempt: 2,
    firstUser: 3,
    from: 60,
    to: 130,
    rampEnd: 120,
    stoppedBy: 'finished',
  },
  { generator: 2, attempt: 1, firstUser: 6, from: 5, to: 130, rampEnd: 10, stoppedBy: 'finished' },
];

function leaveRun(folder: string) {
  const launched = attempts.map((a) => ({
    kind: 'generator-launched',
    at: at(a.from),
    generator: a.generator,
    attempt: a.attempt,
    firstUser: a.firstUser,
    userCount: 3,
    task: `pid-${a.generator}${a.attempt}`,
    spot: false,
    planned: { rampEndsAt: at(a.rampEnd), holdEndsAt: at(130) },
  }));
  const stopped = attempts.map((a) => ({
    kind: 'generator-stopped',
    at: at(a.to),
    generator: a.generator,
    attempt: a.attempt,
    reason: a.stoppedBy,
    detail: a.stoppedBy === 'interrupted' ? 'told to stop' : null,
    replacedByAttempt: a.stoppedBy === 'interrupted' ? 2 : null,
  }));
  put(
    folder,
    LAYOUT.events,
    lines([
      { kind: 'run-started', at: STARTED },
      { kind: 'process-started', at: at(1), name: 'backend', task: 'pid-7' },
      ...launched,
      ...stopped,
      { kind: 'run-ended', at: at(140), outcome: 'finished' },
    ]),
  );
  for (const a of attempts) put(folder, LAYOUT.generatorOutput(a.generator, a.attempt), printed(a));

  const seconds = everyTenSeconds(0, 140);
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
          arrivedAt: at(8),
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
        queuedAt: at(9),
        startedAt: at(9),
        finishedAt: at(10),
        durationMs: 30,
        outcome: 'succeeded',
        errorClass: null,
        errorCode: null,
      }),
      ...seconds.map((second) =>
        record({ kind: 'state', at: at(second), pushStreamsOpen: 9, oldestJobWaitMs: 0 }),
      ),
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

describe('a run that lost one of its generators', () => {
  const folder = mkdtempSync(join(tmpdir(), 'lost-generator-'));
  leaveRun(folder);

  it('is sealed complete, with the stop reason of the lost attempt kept as the slice’s history', async () => {
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
        endedAt: at(140),
        trailingEndsAt: null,
      },
      expected: expectedSourcesOf({ inference: 'real' }),
    });

    const manifest = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    expect(manifest.seal).toMatchObject({ status: 'complete' });
    expect(manifest.slices.find(({ generator }) => generator === 1)?.attempts).toMatchObject([
      {
        attempt: 1,
        stoppedBecause: 'interrupted',
        stopDetail: 'told to stop',
      },
      { attempt: 2, stoppedBecause: 'finished' },
    ]);
  });

  it('rebuilds with the slice and how long it was down named, and still passes', () => {
    const rebuilt = rebuildRun(folder);

    expect(rebuilt.verdict).toBe('pass');
    expect(rebuilt.verdictText).toContain('users 3 to 5 were down for 60 s');
    expect(rebuilt.verdictText).toContain('| generator 1 |');
    expect(rebuilt.verdictText).toContain('## Slices');
  });

  it('joins the lost generator’s lines with its replacement’s, and leaves the others’ as they are', () => {
    const summary = JSON.parse(readFileSync(join(folder, LAYOUT.summary), 'utf8'));

    expect(summary.slices).toEqual([
      expect.objectContaining({
        generator: 0,
        firstUser: 0,
        lastUser: 2,
        requests: 3,
        downSeconds: 0,
      }),
      expect.objectContaining({
        generator: 1,
        down: [expect.objectContaining({ from: at(60), to: at(120) })],
        firstUser: 3,
        lastUser: 5,
        requests: 6,
        downSeconds: 60,
      }),
      expect.objectContaining({
        generator: 2,
        firstUser: 6,
        lastUser: 8,
        requests: 3,
        downSeconds: 0,
      }),
    ]);
    expect(summary.requests.total).toBe(12);
  });

  it('records why the generator stopped on the run’s timeline', () => {
    const timeline = readFileSync(join(folder, LAYOUT.eventsLog), 'utf8');

    expect(timeline).toContain('generator 1 stopped (interrupted: told to stop)');
    expect(timeline).toContain('generator 1 launched on pid-12');
  });
});

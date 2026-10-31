import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LAYOUT } from '../records/layout.ts';
import { readManifest } from '../records/manifest.ts';
import type { Report } from '../records/report.ts';
import { listRunFiles } from './files.ts';
import { archiveLocalRun } from './localArchive.ts';
import type { RunDescription } from './manifestBuilder.ts';
import type { ExpectedSource } from './selfChecks.ts';

const STARTED = '2026-10-15T00:00:00.000Z';
const ENDED = '2026-10-15T00:01:10.000Z';
const at = (seconds: number) => new Date(Date.parse(STARTED) + seconds * 1_000).toISOString();

const description: RunDescription = {
  runId: 'run-1',
  step: 'home-smoke',
  config: { users: 2, generators: 1 },
  target: 'cubi-dev',
  loadPath: 'direct',
  images: {},
  commits: { app: { sha: 'abc123', dirty: false }, harness: { sha: 'abc123', dirty: true } },
  limits: { maxHostCpuPercent: 70 },
  startedAt: STARTED,
  endedAt: ENDED,
  trailingEndsAt: null,
};

const expected: ExpectedSource[] = [
  { service: 'host', kind: 'metrics', path: LAYOUT.hostSamples },
  { service: 'backend', kind: 'logs', path: LAYOUT.processLog('backend') },
];

const REQUEST_KINDS_IN_FIXTURE = ['signin', 'chat', 'push'] as const;

function outcomeOf(kind: string) {
  if (kind === 'chat') return 'streamed';
  return kind === 'push' ? 'held' : 'ok';
}

function requestLine(
  user: number,
  kind: (typeof REQUEST_KINDS_IN_FIXTURE)[number],
  start: number,
  totalMs: number,
) {
  return `REQUEST ${JSON.stringify({
    run: 'run-1',
    generator: 0,
    attempt: 1,
    user,
    kind,
    startedAt: at(start),
    firstByteMs: 10,
    totalMs,
    status: 200,
    outcome: outcomeOf(kind),
    errorCode: null,
  })}`;
}

function reportLine(overrides: Partial<Report> = {}) {
  const report: Report = {
    runId: 'run-1',
    generator: 0,
    attempt: 1,
    startedAt: at(5),
    endedAt: at(60),
    interrupted: false,
    requests: { total: 3, byKind: { signin: 1, chat: 1, push: 1 } },
    phases: {
      ramp: { startedAt: at(6), endedAt: at(11) },
      hold: { startedAt: at(11), endedAt: at(41) },
      rampDown: { startedAt: at(41), endedAt: at(59) },
    },
    ...overrides,
  };
  return `REPORT ${JSON.stringify(report)}`;
}

/** What the backend's log holds when it served the fixture's one chat: its own lines among the logger's. */
function backendLog(overrides: { exchange?: object; includeJob?: boolean } = {}) {
  const record = (appRecord: object) =>
    JSON.stringify({ level: 30, time: 1, pid: 7, hostname: 'h', appRecord, msg: 'app record' });
  return [
    'listening',
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
      ...overrides.exchange,
    }),
    ...(overrides.includeJob === false
      ? []
      : [
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
        ]),
    record({ kind: 'state', at: at(7), pushStreamsOpen: 1, oldestJobWaitMs: 0 }),
    '',
  ].join('\n');
}

function put(folder: string, path: string, content: string) {
  mkdirSync(dirname(join(folder, path)), { recursive: true });
  writeFileSync(join(folder, path), content);
}

/** A run folder as a finished home run leaves it, before its archive. */
function leaveRun(folder: string, output?: string) {
  const events = [
    { kind: 'run-started', at: STARTED },
    { kind: 'process-started', at: at(1), name: 'backend', task: 'pid-7' },
    {
      kind: 'generator-launched',
      at: at(5),
      generator: 0,
      attempt: 1,
      firstUser: 0,
      userCount: 2,
      task: 'pid-9',
      spot: false,
      planned: { rampEndsAt: at(10), holdEndsAt: at(40) },
    },
    {
      kind: 'generator-stopped',
      at: at(60),
      generator: 0,
      attempt: 1,
      reason: 'finished',
      detail: null,
      replacedByAttempt: null,
    },
    { kind: 'run-ended', at: ENDED, outcome: 'finished' },
  ];
  put(folder, LAYOUT.events, events.map((event) => `${JSON.stringify(event)}\n`).join(''));
  put(folder, LAYOUT.processLog('backend'), backendLog());
  put(
    folder,
    LAYOUT.hostSamples,
    `${JSON.stringify({
      at: at(20),
      cpuPercent: 3,
      perCorePercent: [3],
      memoryAvailableBytes: 1,
      memoryUsedPercent: 40,
      swapUsedBytes: 0,
      swapInBytes: 0,
      swapOutBytes: 0,
      loadAverage1: 0.4,
    })}\n`,
  );
  put(
    folder,
    LAYOUT.generatorOutput(0, 1),
    output ??
      [
        'starting',
        requestLine(0, 'signin', 6, 80),
        `STATE ${JSON.stringify({ run: 'run-1', generator: 0, attempt: 1, at: at(10), usersSignedIn: 1, pushStreamsOpen: 1, chattersActive: 1 })}`,
        requestLine(0, 'chat', 8, 900),
        requestLine(0, 'push', 7, 52_000),
        reportLine(),
        '',
      ].join('\n'),
  );
}

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'archive-'));
});

const archive = () =>
  archiveLocalRun({ folder, description, expected, now: () => new Date(ENDED) });

function snapshotOf(root: string) {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[full] = `${statSync(full).mtimeMs}:${readFileSync(full, 'utf8')}`;
    }
  };
  walk(root);
  return files;
}

describe('archiveLocalRun', () => {
  it('seals a run with the manifest of what it was', async () => {
    leaveRun(folder);

    const result = await archive();

    expect(result.status).toBe('sealed');
    const manifest = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    expect(manifest.seal.status).toBe('complete');
    expect(manifest).toMatchObject({
      runId: 'run-1',
      step: 'home-smoke',
      target: 'cubi-dev',
      loadPath: 'direct',
      commits: { app: { sha: 'abc123' }, harness: { sha: 'abc123', dirty: true } },
    });
    expect(manifest.limits).toEqual({ maxHostCpuPercent: 70 });
    expect(manifest.slices).toEqual([
      {
        generator: 0,
        firstUser: 0,
        userCount: 2,
        startedAt: at(5),
        endedAt: at(60),
        hold: { from: at(11), to: at(40) },
        down: [],
        attempts: [
          expect.objectContaining({
            attempt: 1,
            task: 'pid-9',
            spot: false,
            startedAt: at(5),
            stoppedAt: at(60),
            stoppedBecause: 'finished',
          }),
        ],
      },
    ]);
  });

  it('merges every attempt at a slice into one file, and records the window the slice was down', async () => {
    leaveRun(folder);
    const events = readFileSync(join(folder, LAYOUT.events), 'utf8').trim().split('\n');
    const lost = {
      kind: 'generator-stopped',
      at: at(20),
      generator: 0,
      attempt: 1,
      reason: 'interrupted',
      detail: 'reclaimed',
      replacedByAttempt: 2,
    };
    const replacement = {
      kind: 'generator-launched',
      at: at(22),
      generator: 0,
      attempt: 2,
      firstUser: 0,
      userCount: 2,
      task: 'pid-10',
      spot: false,
      planned: { rampEndsAt: at(30), holdEndsAt: at(40) },
    };
    const finished = {
      ...lost,
      at: at(60),
      attempt: 2,
      reason: 'finished',
      detail: null,
      replacedByAttempt: null,
    };
    put(
      folder,
      LAYOUT.events,
      [events[0], events[1], events[2], lost, replacement, finished, events.at(-1)]
        .map((event) => (typeof event === 'string' ? event : JSON.stringify(event)))
        .join('\n'),
    );
    put(
      folder,
      LAYOUT.generatorOutput(0, 1),
      [
        requestLine(0, 'signin', 6, 80),
        reportLine({ interrupted: true, requests: { total: 1, byKind: { signin: 1 } } }),
        '',
      ].join('\n'),
    );
    put(
      folder,
      LAYOUT.generatorOutput(0, 2),
      [
        requestLine(0, 'signin', 23, 80).replace('"attempt":1', '"attempt":2'),
        reportLine({
          attempt: 2,
          requests: { total: 1, byKind: { signin: 1 } },
          phases: {
            ramp: { startedAt: at(22), endedAt: at(31) },
            hold: { startedAt: at(31), endedAt: at(40) },
            rampDown: { startedAt: at(40), endedAt: at(59) },
          },
        }),
        '',
      ].join('\n'),
    );

    await archive();

    const manifest = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    const lines = readFileSync(join(folder, LAYOUT.requests(0)), 'utf8')
      .trim()
      .split('\n');
    expect(lines.map((line) => JSON.parse(line).attempt)).toEqual([1, 2]);
    expect(manifest.slices).toHaveLength(1);
    expect(manifest.slices[0]?.attempts.map(({ attempt }) => attempt)).toEqual([1, 2]);
    expect(manifest.slices[0]?.down).toEqual([
      {
        from: at(20),
        to: at(31),
        reason:
          'its generator stopped (interrupted: reclaimed); a new generator brought the users back',
      },
    ]);
    expect(manifest.files.map(({ path }) => path)).toEqual(
      expect.arrayContaining([LAYOUT.generatorReport(0, 1), LAYOUT.generatorReport(0, 2)]),
    );
  });

  it('sorts the generator’s output into the layout and lists every file with its size and checksum', async () => {
    leaveRun(folder);

    await archive();

    const manifest = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    expect(manifest.files.map((file) => file.path)).toEqual(listRunFiles(folder));
    expect(manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        LAYOUT.requests(0),
        LAYOUT.generatorState(0),
        LAYOUT.generatorReport(0, 1),
        LAYOUT.generatorLog(0, 1),
        LAYOUT.processLog('backend'),
        LAYOUT.hostSamples,
        LAYOUT.events,
      ]),
    );
    for (const file of manifest.files) {
      expect(file.size).toBe(statSync(join(folder, file.path)).size);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(
      readFileSync(join(folder, LAYOUT.requests(0)), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(3);
    expect(readFileSync(join(folder, LAYOUT.generatorLog(0, 1)), 'utf8')).toBe('starting\n');
    expect(existsSync(join(folder, LAYOUT.sourcesDir))).toBe(false);
  });

  it('writes the manifest last', async () => {
    leaveRun(folder);

    await archive();

    const manifestTime = statSync(join(folder, LAYOUT.manifest)).mtimeMs;
    for (const path of listRunFiles(folder)) {
      expect(statSync(join(folder, path)).mtimeMs).toBeLessThanOrEqual(manifestTime);
    }
  });

  it('seals as incomplete, naming the file, when a generator’s requests are missing', async () => {
    leaveRun(folder);
    rmSync(join(folder, LAYOUT.generatorOutput(0, 1)));

    const result = await archive();

    expect(result.status).toBe('sealed');
    const { seal } = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    expect(seal.status).toBe('incomplete');
    if (seal.status !== 'incomplete') return;
    expect(seal.reasons).toContainEqual(
      expect.objectContaining({
        check: 'request-coverage',
        path: LAYOUT.requests(0),
        detail: expect.stringContaining('is missing'),
      }),
    );
  });

  it('seals as incomplete when a generator’s own totals do not match its request lines', async () => {
    leaveRun(
      folder,
      [requestLine(0, 'signin', 6, 80), requestLine(0, 'push', 7, 52_000), reportLine(), ''].join(
        '\n',
      ),
    );

    await archive();

    const { seal } = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    expect(seal.status).toBe('incomplete');
    if (seal.status !== 'incomplete') return;
    expect(seal.reasons.map((reason) => reason.check)).toContain('request-totals');
  });

  it('does not hold a generator that was cut off to totals it never printed', async () => {
    leaveRun(
      folder,
      [requestLine(0, 'signin', 6, 80), requestLine(0, 'push', 7, 1_000), '{"half'].join('\n'),
    );

    await archive();

    const { seal } = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    expect(seal.status === 'incomplete' ? seal.reasons.map((r) => r.check) : []).not.toContain(
      'request-totals',
    );
  });

  it('seals as incomplete when an expected service left no logs', async () => {
    leaveRun(folder);
    rmSync(join(folder, LAYOUT.processLog('backend')));

    await archive();

    const { seal } = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    expect(seal.status === 'incomplete' ? seal.reasons : []).toContainEqual(
      expect.objectContaining({ check: 'services-recorded', path: LAYOUT.processLog('backend') }),
    );
  });

  it('sorts the backend’s own records out of its log into app/, as the lines the backend wrote', async () => {
    leaveRun(folder);

    await archive();

    const manifest = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    expect(manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([LAYOUT.exchanges, LAYOUT.jobs, LAYOUT.appState]),
    );
    const exchanges = readFileSync(join(folder, LAYOUT.exchanges), 'utf8').trim().split('\n');
    expect(exchanges).toHaveLength(1);
    expect(JSON.parse(exchanges[0] ?? '')).toMatchObject({
      userId: 'u1',
      outcome: 'completed',
      firstTokenAfterMs: 300,
    });
    expect(exchanges[0]).not.toContain('appRecord');
    expect(exchanges[0]).not.toContain('hostname');
    expect(readFileSync(join(folder, LAYOUT.jobs), 'utf8')).toContain('"task":"driftGateFoldTurn"');
    expect(readFileSync(join(folder, LAYOUT.appState), 'utf8')).toContain('"pushStreamsOpen":1');
  });

  /** The findings an archive sealed the run with; empty for a run sealed complete. */
  function reasonsOf(): { check: string; path: string | null; detail: string }[] {
    const { seal } = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    return seal.status === 'incomplete' ? seal.reasons : [];
  }

  it('seals as incomplete when the backend’s log has no records at all', async () => {
    leaveRun(folder);
    put(folder, LAYOUT.processLog('backend'), 'listening\n');

    await archive();

    expect(reasonsOf()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: 'app-records', path: LAYOUT.exchanges }),
        expect.objectContaining({ check: 'app-records', path: LAYOUT.jobs }),
        expect.objectContaining({ check: 'app-records', path: LAYOUT.appState }),
      ]),
    );
  });

  it('seals as incomplete, naming each file, when the backend left no log to take them from', async () => {
    leaveRun(folder);
    rmSync(join(folder, LAYOUT.processLog('backend')));

    await archive();

    const missing = reasonsOf().filter((reason) => reason.check === 'app-records');
    expect(missing.map((reason) => reason.path)).toEqual([
      LAYOUT.exchanges,
      LAYOUT.jobs,
      LAYOUT.appState,
    ]);
  });

  it('seals as incomplete when a chat the generators saw stream has no exchange line', async () => {
    leaveRun(folder);
    put(
      folder,
      LAYOUT.processLog('backend'),
      backendLog({ exchange: { firstTokenAfterMs: null, outcome: 'paused' } }),
    );

    await archive();

    expect(reasonsOf()).toContainEqual(
      expect.objectContaining({
        check: 'app-records',
        path: LAYOUT.exchanges,
        detail: expect.stringContaining('saw 1 chats stream'),
      }),
    );
  });

  it('seals as incomplete when chats streamed and the worker wrote no job line', async () => {
    leaveRun(folder);
    put(folder, LAYOUT.processLog('backend'), backendLog({ includeJob: false }));

    await archive();

    expect(reasonsOf()).toContainEqual(
      expect.objectContaining({ check: 'app-records', path: LAYOUT.jobs }),
    );
  });

  it('reports a record that does not match its schema as that, and not as missing', async () => {
    leaveRun(folder);
    put(folder, LAYOUT.processLog('backend'), backendLog({ exchange: { outcome: 'shrugged' } }));

    await archive();

    const reasons = reasonsOf();
    expect(reasons).toContainEqual(
      expect.objectContaining({ check: 'records-valid', path: LAYOUT.exchanges }),
    );
    expect(reasons.map((reason) => reason.check)).not.toContain('app-records');
  });

  it('seals as incomplete when an expected service’s metrics fall outside the run’s window', async () => {
    leaveRun(folder);
    put(
      folder,
      LAYOUT.hostSamples,
      `${JSON.stringify({ at: '2026-10-14T00:00:00.000Z', cpuPercent: 3, perCorePercent: [3], memoryAvailableBytes: 1, memoryUsedPercent: 40, swapUsedBytes: 0, swapInBytes: 0, swapOutBytes: 0, loadAverage1: 0.4 })}\n`,
    );

    await archive();

    const { seal } = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    expect(seal.status === 'incomplete' ? seal.reasons : []).toContainEqual(
      expect.objectContaining({ check: 'services-recorded', path: LAYOUT.hostSamples }),
    );
  });

  it('seals as incomplete when a record file does not match its schema', async () => {
    leaveRun(folder);
    put(folder, LAYOUT.hostSamples, '{"at":"x"}\n');

    await archive();

    const { seal } = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    expect(seal.status === 'incomplete' ? seal.reasons : []).toContainEqual(
      expect.objectContaining({ check: 'records-valid', path: LAYOUT.hostSamples }),
    );
  });

  it('seals as incomplete when the run’s events are missing', async () => {
    leaveRun(folder);
    rmSync(join(folder, LAYOUT.events));

    await archive();

    const { seal } = readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8'));
    expect(seal.status === 'incomplete' ? seal.reasons : []).toContainEqual(
      expect.objectContaining({ check: 'records-valid', path: LAYOUT.events }),
    );
  });

  it('changes nothing when the run is already sealed', async () => {
    leaveRun(folder);
    await archive();
    const before = snapshotOf(folder);

    const again = await archive();

    expect(again.status).toBe('already-sealed');
    expect(snapshotOf(folder)).toEqual(before);
  });

  it('reports a sealed file that no longer matches, and does not repair it', async () => {
    leaveRun(folder);
    await archive();
    writeFileSync(join(folder, LAYOUT.requests(0)), 'tampered\n');

    const again = await archive();

    expect(again.status === 'already-sealed' ? again.problems : []).toContainEqual(
      expect.objectContaining({ check: 'checksums', path: LAYOUT.requests(0) }),
    );
    expect(readFileSync(join(folder, LAYOUT.requests(0)), 'utf8')).toBe('tampered\n');
  });

  it('resumes a failed archive, leaving the files it already wrote as they are', async () => {
    leaveRun(folder);
    // A folder where the backend's log should be makes reading it fail once the generator's files are written.
    const backendLog = join(folder, LAYOUT.processLog('backend'));
    const backendOutput = readFileSync(backendLog);
    unlinkSync(backendLog);
    mkdirSync(backendLog);
    await expect(archive()).rejects.toThrow(/EISDIR/);
    expect(existsSync(join(folder, LAYOUT.requests(0)))).toBe(true);
    rmdirSync(backendLog);
    writeFileSync(backendLog, backendOutput);
    expect(existsSync(join(folder, LAYOUT.manifest))).toBe(false);
    const requests = join(folder, LAYOUT.requests(0));
    const writtenBefore = statSync(requests).mtimeMs;

    const result = await archive();

    expect(result.status).toBe('sealed');
    expect(result.status === 'sealed' ? result.skipped : []).toContain(LAYOUT.requests(0));
    expect(result.status === 'sealed' ? result.written : []).not.toContain(LAYOUT.requests(0));
    expect(statSync(requests).mtimeMs).toBe(writtenBefore);
    expect(readManifest(readFileSync(join(folder, LAYOUT.manifest), 'utf8')).seal.status).toBe(
      'complete',
    );
  });

  it('skips files already present with matching checksums on a second pass', async () => {
    leaveRun(folder);
    const first = await archive();
    expect(first.status === 'sealed' ? first.written : []).toContain(LAYOUT.requests(0));
    // The same run again: the sorted files stay, and only the unsorted output returns.
    rmSync(join(folder, LAYOUT.manifest));
    leaveRun(folder);
    const before = statSync(join(folder, LAYOUT.requests(0))).mtimeMs;

    const second = await archive();

    expect(second.status === 'sealed' ? second.skipped : []).toEqual(
      expect.arrayContaining([LAYOUT.requests(0), LAYOUT.generatorState(0)]),
    );
    expect(second.status === 'sealed' ? second.written : []).not.toContain(LAYOUT.requests(0));
    expect(statSync(join(folder, LAYOUT.requests(0))).mtimeMs).toBe(before);
  });
});

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type ExpectedSource, archiveLocalRun, lineSink } from '../archive/index.ts';
import { LAYOUT, type Report, type RequestKind } from '../records/index.ts';

/** How big a run to make. */
type ScaleOptions = {
  generators: number;
  requestsPerGenerator: number;
  /** How long the run lasts, in minutes. */
  minutes: number;
  /** How much unrelated output the backend's log holds besides its records, in megabytes. */
  backendNoiseMegabytes: number;
};

/** About what a step50 run leaves: ten generators, a million requests, thirty-five minutes. */
export const STEP50_SCALE: ScaleOptions = {
  generators: 10,
  requestsPerGenerator: 100_000,
  minutes: 35,
  backendNoiseMegabytes: 0,
};

const STARTED = Date.parse('2026-10-20T00:00:00.000Z');
const RAMP_MINUTES = 5;
const USERS_PER_GENERATOR = 5_000;
const NOISE_LINE = `${'noise '.repeat(32)}end`;

/** A moment `seconds` into the run, as the records write it. */
const scaleAt = (seconds: number) => new Date(STARTED + seconds * 1_000).toISOString();

async function writeLines(
  folder: string,
  path: string,
  lines: Iterable<string> | Generator<string>,
) {
  mkdirSync(dirname(join(folder, path)), { recursive: true });
  const sink = lineSink(join(folder, path));
  for (const line of lines) await sink.write(line);
  await sink.end();
}

const KINDS: readonly RequestKind[] = ['chat', 'chat', 'chat', 'chat', 'thread', 'refresh'];

/** The kind of a generator's nth request: its users sign in, then open their push streams, then chat and the like. */
function kindOfRequest(n: number) {
  if (n < USERS_PER_GENERATOR) return 'signin';
  if (n < 2 * USERS_PER_GENERATOR) return 'push';
  return KINDS[n % KINDS.length] ?? 'chat';
}

/** What one generator printed: its request lines, a state line every five seconds, and its report. */
function* generatorOutput(generator: number, options: ScaleOptions, counts: Report['requests']) {
  const seconds = options.minutes * 60;
  const firstUser = generator * USERS_PER_GENERATOR;
  const totals: Record<string, number> = {};
  const count = (kind: RequestKind): void => {
    totals[kind] = (totals[kind] ?? 0) + 1;
  };
  const each = (seconds - 10) / options.requestsPerGenerator;
  for (let n = 0; n < options.requestsPerGenerator; n += 1) {
    const kind = kindOfRequest(n);
    count(kind);
    const startedAt = 5 + n * each;
    yield `REQUEST ${JSON.stringify({
      run: 'scale-run',
      generator,
      attempt: 1,
      user: firstUser + (n % USERS_PER_GENERATOR),
      kind,
      startedAt: scaleAt(startedAt),
      firstByteMs: kind === 'push' ? 5 : 120,
      totalMs: kind === 'push' ? 600_000 : 400,
      status: 200,
      outcome: kind === 'chat' ? 'streamed' : kind === 'push' ? 'held' : 'ok',
      errorCode: null,
    })}`;
  }
  for (let second = 10; second <= seconds; second += 5) {
    yield `STATE ${JSON.stringify({
      run: 'scale-run',
      generator,
      attempt: 1,
      at: scaleAt(second),
      usersSignedIn: USERS_PER_GENERATOR,
      pushStreamsOpen: USERS_PER_GENERATOR,
      chattersActive: 1_000,
    })}`;
  }
  const report: Report = {
    runId: 'scale-run',
    generator,
    attempt: 1,
    startedAt: scaleAt(0),
    endedAt: scaleAt(seconds),
    interrupted: false,
    requests: { total: options.requestsPerGenerator, byKind: totals },
    phases: {
      ramp: { startedAt: scaleAt(5), endedAt: scaleAt(RAMP_MINUTES * 60) },
      hold: { startedAt: scaleAt(RAMP_MINUTES * 60), endedAt: scaleAt(seconds) },
      rampDown: { startedAt: scaleAt(seconds), endedAt: scaleAt(seconds) },
    },
  };
  counts.total = report.requests.total;
  yield `REPORT ${JSON.stringify(report)}`;
}

const record = (appRecord: object) =>
  JSON.stringify({ level: 30, time: 1, pid: 7, hostname: 'h', appRecord, msg: 'app record' });

/** What the backend logged: an exchange and a job for every chat, a state line every five seconds, and noise between. */
function* backendLog(options: ScaleOptions) {
  const seconds = options.minutes * 60;
  const chats = (options.generators * options.requestsPerGenerator * 2) / 3;
  const noiseLines = (options.backendNoiseMegabytes * 1_048_576) / NOISE_LINE.length;
  const noisePerChat = Math.ceil(noiseLines / chats);
  yield 'listening';
  for (let n = 0; n < chats; n += 1) {
    const arrivedAt = scaleAt(5 + (n / chats) * (seconds - 10));
    yield record({
      kind: 'exchange',
      userId: `u${n % 1_000}`,
      trigger: 'submit',
      arrivedAt,
      verdict: 'pass',
      verdictAfterMs: 40,
      firstTokenAfterMs: 300,
      endedAfterMs: 880,
      outcome: 'completed',
      errorCode: null,
      assistantMessageId: `m${n}`,
    });
    yield record({
      kind: 'job',
      task: 'driftGateFoldTurn',
      jobId: String(n),
      attempt: 1,
      queuedAt: arrivedAt,
      startedAt: arrivedAt,
      finishedAt: arrivedAt,
      durationMs: 30,
      outcome: 'succeeded',
      errorClass: null,
      errorCode: null,
    });
    for (let noise = 0; noise < noisePerChat; noise += 1) yield NOISE_LINE;
  }
  for (let second = 0; second <= seconds; second += 5) {
    yield record({ kind: 'state', at: scaleAt(second), pushStreamsOpen: 100, oldestJobWaitMs: 0 });
  }
}

/** Samples of the host, every five seconds. */
function* samples(options: ScaleOptions, shape: (second: number) => object) {
  for (let second = 0; second <= options.minutes * 60; second += 5)
    yield JSON.stringify(shape(second));
}

/** The logs and metrics a run on one machine must leave. */
const EXPECTED: ExpectedSource[] = [
  { service: 'host', kind: 'metrics', path: LAYOUT.hostSamples },
  { service: 'backend', kind: 'logs', path: LAYOUT.processLog('backend') },
];

/**
 * Leaves in `folder` a run of the size asked for, as the run command leaves
 * one, ready to be archived. Everything is written a line at a time, so a
 * run of any size can be made.
 */
export async function leaveScaleRun(folder: string, options: ScaleOptions) {
  const seconds = options.minutes * 60;
  const generators = Array.from({ length: options.generators }, (_, index) => index);
  await writeLines(folder, LAYOUT.events, [
    JSON.stringify({ kind: 'run-started', at: scaleAt(0) }),
    JSON.stringify({ kind: 'process-started', at: scaleAt(1), name: 'backend', task: 'pid-7' }),
    ...generators.map((generator) =>
      JSON.stringify({
        kind: 'generator-launched',
        at: scaleAt(0),
        generator,
        attempt: 1,
        firstUser: generator * USERS_PER_GENERATOR,
        userCount: USERS_PER_GENERATOR,
        task: `pid-${generator}`,
        spot: false,
        planned: { rampEndsAt: scaleAt(RAMP_MINUTES * 60), holdEndsAt: scaleAt(seconds) },
      }),
    ),
    ...generators.map((generator) =>
      JSON.stringify({
        kind: 'generator-stopped',
        at: scaleAt(seconds),
        generator,
        attempt: 1,
        reason: 'finished',
        detail: null,
        replacedByAttempt: null,
      }),
    ),
    JSON.stringify({ kind: 'run-ended', at: scaleAt(seconds), outcome: 'finished' }),
  ]);
  for (const generator of generators) {
    await writeLines(
      folder,
      LAYOUT.generatorOutput(generator, 1),
      generatorOutput(generator, options, { total: 0, byKind: {} }),
    );
  }
  await writeLines(folder, LAYOUT.processLog('backend'), backendLog(options));
  await writeLines(
    folder,
    LAYOUT.hostSamples,
    samples(options, (second) => ({
      at: scaleAt(second),
      cpuPercent: 20,
      perCorePercent: [20],
      memoryAvailableBytes: 1,
      memoryUsedPercent: 40,
      swapUsedBytes: 0,
      swapInBytes: 0,
      swapOutBytes: 0,
      loadAverage1: 0.4,
    })),
  );
}

/** Archives a run `leaveScaleRun` left, sealing it. */
export async function archiveScaleRun(folder: string, options: ScaleOptions) {
  const seconds = options.minutes * 60;
  await archiveLocalRun({
    folder,
    description: {
      runId: 'scale-run',
      step: 'home-smoke',
      config: {},
      target: 'cubi-dev',
      loadPath: 'direct',
      images: {},
      commits: { app: { sha: 'a', dirty: false }, harness: { sha: 'a', dirty: false } },
      limits: {},
      startedAt: scaleAt(0),
      endedAt: scaleAt(seconds),
      trailingEndsAt: null,
    },
    expected: EXPECTED,
  });
}

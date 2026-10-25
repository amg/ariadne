import {
  type AppRequestLine,
  type AppStateLine,
  type ExchangeLine,
  type Manifest,
  type ManifestSlice,
  RUN_FOLDER_VERSION,
  type RequestLine,
  appStateRecords,
} from '../../records/index.ts';
import type { RunData, SliceData } from '../types.ts';

export const STARTED = '2026-10-15T00:00:00.000Z';
export const ENDED = '2026-10-15T00:03:00.000Z';

/** A moment `seconds` after the run began, as the records write it. */
export const at = (seconds: number) =>
  new Date(Date.parse(STARTED) + seconds * 1_000).toISOString();

export function manifestWith(overrides: Partial<Manifest> = {}): Manifest {
  return {
    version: RUN_FOLDER_VERSION,
    runId: 'run-1',
    step: 'home-smoke',
    config: {},
    target: 'cubi-dev',
    loadPath: 'direct',
    images: {},
    commits: { app: { sha: 'a', dirty: false }, harness: { sha: 'a', dirty: false } },
    startedAt: STARTED,
    endedAt: ENDED,
    trailingEndsAt: null,
    limits: {
      maxHostCpuPercent: 70,
      maxMemoryUsedPercent: 80,
      maxFirstByteP95Ms: 2_500,
      maxErrorShare: 0.01,
    },
    slices: [],
    files: [],
    seal: { status: 'complete', sealedAt: at(181) },
    ...overrides,
  };
}

/** Slice 0, users 0 to 9, held by one generator from second 1 to second 170, with no plan and never down. */
export function sliceWith(overrides: Partial<ManifestSlice> = {}): ManifestSlice {
  return {
    generator: 0,
    firstUser: 0,
    userCount: 10,
    startedAt: at(1),
    endedAt: at(170),
    hold: null,
    down: [],
    attempts: [
      {
        attempt: 1,
        task: 'pid-1',
        spot: false,
        startedAt: at(1),
        stoppedAt: at(170),
        stoppedBecause: 'finished',
        stopDetail: null,
        toldToStopAt: null,
        stoppedForRunEnd: false,
      },
    ],
    ...overrides,
  };
}

export function requestWith(overrides: Partial<RequestLine> = {}): RequestLine {
  return {
    run: 'run-1',
    generator: 0,
    attempt: 1,
    user: 0,
    kind: 'chat',
    startedAt: at(10),
    firstByteMs: 100,
    totalMs: 200,
    status: 200,
    outcome: 'streamed',
    errorCode: null,
    ...overrides,
  };
}

/** One chat request as the API recorded it: a submit the gate passed, that streamed a reply. */
export function exchangeWith(overrides: Partial<ExchangeLine> = {}): ExchangeLine {
  return {
    copy: 'api-1',
    userId: 'user-1',
    trigger: 'submit',
    arrivedAt: at(10),
    verdict: 'pass',
    verdictReplayed: false,
    verdictAfterMs: 40,
    firstTokenAfterMs: 90,
    endedAfterMs: 200,
    outcome: 'completed',
    errorCode: null,
    assistantMessageId: 'reply-1',
    ...overrides,
  };
}

/** One request as the API recorded it: a chat that took a second and succeeded. */
export function appRequestWith(overrides: Partial<AppRequestLine> = {}) {
  return {
    copy: 'api-1',
    endedAt: at(10),
    method: 'POST',
    route: '/api/threads/:threadId/messages',
    statusCode: 200,
    durationMs: 1_000,
    ...overrides,
  };
}

/** One state record of a copy that measures only what a test gives it. */
export function appStateWith(overrides: Partial<AppStateLine> = {}) {
  return appStateRecords.read({
    copy: 'api-1',
    at: at(10),
    pushStreamsOpen: null,
    oldestJobWaitMs: null,
    ...overrides,
  });
}

/** What one slice left: its lines, none unless given. */
export function sliceDataWith(slice: ManifestSlice, parts: Partial<Omit<SliceData, 'slice'>> = {}) {
  return { slice, requests: [], states: [], ...parts };
}

/**
 * A run that read cleanly and holds nothing; each test adds what it needs.
 * The manifest lists the slices the run holds.
 */
export function runDataWith(overrides: Partial<RunData> = {}): RunData {
  const slices = overrides.slices ?? [];
  return {
    manifest: manifestWith({ slices: slices.map(({ slice }) => slice) }),
    events: [
      { kind: 'run-started', at: STARTED },
      { kind: 'run-ended', at: ENDED, outcome: 'finished' },
    ],
    slices,
    host: [],
    exchanges: [],
    jobs: [],
    appRequests: [],
    appStates: [],
    afterRun: null,
    insights: null,
    awsMetrics: [],
    awsEvents: null,
    trouble: [],
    ...overrides,
  };
}

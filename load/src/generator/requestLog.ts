import type { RequestKind, RequestLine } from '../records/index.ts';
import { requestLineText } from './lines.ts';

/** A wall-clock start with a monotonic clock running from it. */
type Stopwatch = {
  /** UTC with milliseconds. */
  startedAt: string;
  elapsedMs: () => number;
};

/** Starts timing now. The start is the wall clock; every duration is read from a monotonic clock. */
export function startStopwatch() {
  const startedAt = new Date().toISOString();
  const began = performance.now();
  return { startedAt, elapsedMs: () => performance.now() - began };
}

/** What a request left to record; the log adds who made it. */
type RequestDetails = Pick<
  RequestLine,
  'kind' | 'startedAt' | 'firstByteMs' | 'totalMs' | 'status' | 'outcome' | 'errorCode'
>;

/** A request that never got an answer: its time to first byte is the whole wait. */
function unreachable(kind: RequestKind, clock: Stopwatch): RequestDetails {
  const totalMs = clock.elapsedMs();
  return {
    kind,
    startedAt: clock.startedAt,
    firstByteMs: totalMs,
    totalMs,
    status: null,
    outcome: 'failed',
    errorCode: 'unreachable',
  };
}

/** An answer that began before the request was cut short: its status and when it began. */
type BegunAnswer = { status: number; firstByteMs: number };

/**
 * A request the generator cut short because it was told to stop; it is no
 * failure of the app. `begun` is the answer that had begun, if any had.
 */
export function cutShort(
  kind: RequestKind,
  clock: Stopwatch,
  begun: BegunAnswer | null,
): RequestDetails {
  const totalMs = clock.elapsedMs();
  return {
    kind,
    startedAt: clock.startedAt,
    firstByteMs: begun?.firstByteMs ?? totalMs,
    totalMs,
    status: begun?.status ?? null,
    outcome: 'stopped',
    errorCode: null,
  };
}

/** A request that got no answer: cut short when `signal` has aborted, and otherwise unreachable. */
export function unanswered(
  kind: RequestKind,
  clock: Stopwatch,
  signal: AbortSignal,
): RequestDetails {
  return signal.aborted ? cutShort(kind, clock, null) : unreachable(kind, clock);
}

/** Where one user's requests are written. */
export type UserRequests = { record: (details: RequestDetails) => void };

type RequestLog = {
  forUser: (user: number) => UserRequests;
  /** How many lines have been written, in all and by kind. */
  counts: () => { total: number; byKind: Partial<Record<RequestKind, number>> };
};

/**
 * A log of the requests one generator attempt makes, one line each. Each
 * line is handed to `emit` as it happens, so a generator that is lost
 * keeps everything but the request in flight. Where metrics are published,
 * each line also publishes its request's figures.
 */
export function createRequestLog(
  who: { run: string; generator: number; attempt: number },
  emit: (line: string) => void,
  publishMetrics = false,
): RequestLog {
  const byKind: Partial<Record<RequestKind, number>> = {};
  let total = 0;
  return {
    forUser: (user) => ({
      record(details) {
        total += 1;
        byKind[details.kind] = (byKind[details.kind] ?? 0) + 1;
        const line: RequestLine = { ...who, user, ...details };
        emit(requestLineText(line, publishMetrics));
      },
    }),
    counts: () => ({ total, byKind: { ...byKind } }),
  };
}

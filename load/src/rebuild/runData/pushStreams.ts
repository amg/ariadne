import type { RequestLine } from '../../records/index.ts';
import { compareText } from '../numbers.ts';
import type { RunData, SliceData } from '../types.ts';
import { requestsOf } from './requests.ts';

/** How soon a user must open a push stream again, after one ended, for the stream to count as reopened. */
export const REOPENED_WITHIN_MS = 10_000;

/**
 * A push stream that opened and then ended before its user let it go:
 * the server, or something between, closed it or broke it off.
 */
type EndedPushStream = {
  line: RequestLine;
  /** When the stream ended, in milliseconds. */
  endedAt: number;
  /** How long the stream had been open. */
  lastedMs: number;
  /** Whether the stream broke off rather than closing cleanly. */
  cut: boolean;
  /** Whether its user had a push stream open again within the reopen window. */
  reopened: boolean;
  /** When its user opened the next one, in milliseconds; null when not within the reopen window. */
  reopenedAt: number | null;
};

/** Whether a request was a push stream that opened: the server answered it with its headers. */
export function isOpenedPushStream(line: RequestLine) {
  return line.kind === 'push' && line.status === 200;
}

/**
 * Whether a request was a push stream that opened and then broke off
 * mid-stream. A load balancer never counts such a stream as answered,
 * because it never completed.
 */
export function isBrokenOff(line: RequestLine) {
  return isOpenedPushStream(line) && line.outcome === 'failed';
}

/** Whether a push stream opened, and then ended before its user let it go. */
function endedEarly(line: RequestLine) {
  if (!isOpenedPushStream(line)) return false;
  return line.outcome === 'dropped' || line.outcome === 'failed';
}

/** What names one request of one user, whichever object holds its line. */
function requestKeyOf(line: RequestLine) {
  return `${line.generator}|${line.attempt}|${line.user}|${line.kind}|${line.startedAt}`;
}

/** The ended streams of each run's request lines, worked out once however often they are asked for. */
const endedBySlices = new WeakMap<readonly SliceData[], readonly EndedPushStream[]>();

/**
 * Every push stream of the run that opened and then ended before its user
 * let it go, oldest first, each with whether its user opened another soon
 * after.
 */
export function endedPushStreamsOf(data: Pick<RunData, 'slices'>) {
  const known = endedBySlices.get(data.slices);
  if (known !== undefined) return known;
  const ended = findEndedPushStreams(requestsOf(data));
  endedBySlices.set(data.slices, ended);
  return ended;
}

function findEndedPushStreams(requests: readonly RequestLine[]) {
  const startsByUser = new Map<string, number[]>();
  const userOf = (line: RequestLine) => `${line.generator}|${line.user}`;
  for (const line of requests) {
    if (line.kind !== 'push') continue;
    const starts = startsByUser.get(userOf(line));
    if (starts === undefined) startsByUser.set(userOf(line), [Date.parse(line.startedAt)]);
    else starts.push(Date.parse(line.startedAt));
  }
  const ended: EndedPushStream[] = [];
  for (const line of requests) {
    if (!endedEarly(line)) continue;
    const startedAt = Date.parse(line.startedAt);
    const endedAt = startedAt + line.totalMs;
    const next = (startsByUser.get(userOf(line)) ?? []).filter(
      (start) => start > startedAt && start >= endedAt && start - endedAt <= REOPENED_WITHIN_MS,
    );
    const reopenedAt = next.length === 0 ? null : Math.min(...next);
    ended.push({
      line,
      endedAt,
      lastedMs: line.totalMs,
      cut: isBrokenOff(line),
      reopened: reopenedAt !== null,
      reopenedAt,
    });
  }
  return ended.sort(
    (a, b) =>
      a.endedAt - b.endedAt ||
      a.line.generator - b.line.generator ||
      a.line.user - b.line.user ||
      compareText(a.line.startedAt, b.line.startedAt),
  );
}

/**
 * Whether a failed request is one of the push streams that broke off and
 * its user reopened within seconds. Such a stream did its job until it
 * broke, and the user lost nothing they would notice, so it is counted
 * apart from the failures.
 */
export function isCutAndReopenedIn(data: Pick<RunData, 'slices'>): (line: RequestLine) => boolean {
  const keys = new Set(
    endedPushStreamsOf(data)
      .filter((stream) => stream.cut && stream.reopened)
      .map((stream) => requestKeyOf(stream.line)),
  );
  return (line) => keys.size > 0 && line.kind === 'push' && keys.has(requestKeyOf(line));
}

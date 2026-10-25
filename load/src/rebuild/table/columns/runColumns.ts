import {
  REQUEST_KINDS,
  type RequestKind,
  type RequestLine,
  isChat,
} from '../../../records/index.ts';
import { MINUTE_MS, instantOf, windowsInMs } from '../../moments.ts';
import { PERCENTILES, percentOrNull, percentileOf, roundTo } from '../../numbers.ts';
import {
  endedPushStreamsOf,
  isBrokenOff,
  isCutAndReopenedIn,
  isOpenedPushStream,
  requestsOf,
} from '../../runData/index.ts';
import type { Cell, RunData } from '../../types.ts';
import { usersByMinute } from '../users.ts';
import { type Column, byMinute, maxInMinute, splitName } from './minutes.ts';

type EndedPushStream = ReturnType<typeof endedPushStreamsOf>[number];

/** The name of the column that counts the failed requests of one kind. */
export function failureColumnName(kind: RequestKind) {
  return `failures_${kind.replaceAll('-', '_')}`;
}

/** What the generators' users held, from their state lines. */
export function userColumns(data: RunData): Column[] {
  const users = usersByMinute(data);
  return [
    { name: 'users_signed_in', at: (minute) => users.get(minute)?.signedIn ?? null },
    { name: 'push_streams_open', at: (minute) => users.get(minute)?.pushStreams ?? null },
    { name: 'chatters_active', at: (minute) => users.get(minute)?.chatters ?? null },
  ];
}

/**
 * What the generators' requests did, from their request lines. A push
 * stream cut off and reopened within seconds is not counted as a failure.
 */
export function requestColumns(data: RunData): Column[] {
  const reopened = isCutAndReopenedIn(data);
  const failed = (line: RequestLine): boolean => line.outcome === 'failed' && !reopened(line);
  const requests = byMinute(requestsOf(data), (line) => line.startedAt);
  const inMinute = (minute: number) => requests.get(minute) ?? [];
  const firstBytes = (minute: number): number[] =>
    inMinute(minute)
      .filter((line) => isChat(line) && line.outcome === 'streamed')
      .map((line) => line.firstByteMs);
  const hasRequests = data.slices.some(({ requests: lines }) => lines !== null);
  const count =
    (pick: (minute: number) => number): ((minute: number) => Cell) =>
    (minute) =>
      hasRequests ? pick(minute) : null;
  const signIns = (minute: number) => inMinute(minute).filter((line) => line.kind === 'signin');
  return [
    { name: 'requests', at: count((minute) => inMinute(minute).length) },
    {
      name: 'refreshes',
      at: count((minute) => inMinute(minute).filter((line) => line.kind === 'refresh').length),
    },
    {
      name: 'failures',
      at: count((minute) => inMinute(minute).filter(failed).length),
    },
    {
      name: 'failed_percent',
      places: 2,
      at: (minute: number) =>
        percentOrNull(inMinute(minute).filter(failed).length, inMinute(minute).length),
    },
    ...REQUEST_KINDS.map((kind) => ({
      name: failureColumnName(kind),
      at: count(
        (minute) => inMinute(minute).filter((line) => line.kind === kind && failed(line)).length,
      ),
    })),
    {
      name: 'signin_failures_percent',
      places: 2,
      at: (minute: number) =>
        percentOrNull(signIns(minute).filter(failed).length, signIns(minute).length),
    },
    ...PERCENTILES.map(([label, share]) => ({
      name: `chat_first_byte_${label}_ms`,
      at: (minute: number) => percentileOf(firstBytes(minute), share),
    })),
    ...answeredColumns(data, hasRequests),
  ];
}

/** The names of the columns that count the generators' answered requests by the minute each ended in. */
export const ANSWERED_BY_END = {
  all: 'answered_by_end_minute',
  serverErrors: 'answered_5xx_by_end_minute',
  clientErrors: 'answered_4xx_by_end_minute',
} as const;

/**
 * The requests that got an answer, counted in the minute each ended in, as
 * a load balancer counts them: all of them, and those that were server or
 * client errors. A request that got no answer is not counted, and nor is a
 * push stream that broke off, which never completed.
 */
function answeredColumns(data: RunData, hasRequests: boolean): Column[] {
  const answered = requestsOf(data).filter((line) => line.status !== null && !isBrokenOff(line));
  const ended = byMinute(answered, (line) => instantOf(Date.parse(line.startedAt) + line.totalMs));
  const status = (line: RequestLine): number => line.status ?? 0;
  const count =
    (keep: (line: RequestLine) => boolean): ((minute: number) => Cell) =>
    (minute) =>
      hasRequests ? (ended.get(minute) ?? []).filter(keep).length : null;
  return [
    { name: ANSWERED_BY_END.all, at: count(() => true) },
    { name: ANSWERED_BY_END.serverErrors, at: count((line) => status(line) >= 500) },
    {
      name: ANSWERED_BY_END.clientErrors,
      at: count((line) => status(line) >= 400 && status(line) < 500),
    },
  ];
}

/** The name of the column that counts the push streams that broke off, by the minute they ended in. */
export const PUSH_STREAMS_CUT = 'push_streams_cut';

/** How long a push stream that ended early had lasted, in bands, shortest first. */
const LASTED_BANDS = [
  { value: 'under_1m', fromMs: 0 },
  { value: '1m_to_5m', fromMs: MINUTE_MS },
  { value: '5m_to_15m', fromMs: 5 * MINUTE_MS },
  { value: '15m_or_more', fromMs: 15 * MINUTE_MS },
] as const;

const PUSH_ENDED_LASTED = 'push_streams_ended_lasted';

/** The band of how long a stream lasted. */
function lastedBandOf(stream: EndedPushStream): string {
  const band = LASTED_BANDS.findLast(({ fromMs }) => stream.lastedMs >= fromMs);
  return band?.value ?? LASTED_BANDS[0].value;
}

/**
 * What became of the generators' push streams: those opened in each minute,
 * and those that ended before their users let them go, by the minute they
 * ended in, how they ended, whether their users opened another within
 * seconds, and how long they had lasted. No columns for a run whose generators opened
 * no push stream, or whose request lines are all missing.
 */
export function pushStreamColumns(data: RunData): Column[] {
  const pushes = requestsOf(data).filter(isOpenedPushStream);
  if (pushes.length === 0) return [];
  const opened = byMinute(pushes, (line) => line.startedAt);
  const ended = byMinute(endedPushStreamsOf(data), (stream) => instantOf(stream.endedAt));
  const endedIn = (minute: number) => ended.get(minute) ?? [];
  const lastedSeconds = (minute: number) => endedIn(minute).map(({ lastedMs }) => lastedMs / 1_000);
  return [
    { name: 'push_streams_opened', at: (minute) => opened.get(minute)?.length ?? 0 },
    { name: 'push_streams_ended_early', at: (minute) => endedIn(minute).length },
    {
      name: PUSH_STREAMS_CUT,
      at: (minute) => endedIn(minute).filter(({ cut }) => cut).length,
    },
    {
      name: 'push_streams_reopened',
      at: (minute) => endedIn(minute).filter(({ reopened }) => reopened).length,
    },
    {
      name: 'push_streams_ended_lasted_p50_s',
      at: (minute) => {
        const median = percentileOf(lastedSeconds(minute), 0.5);
        return median === null ? null : roundTo(median, 1);
      },
    },
    ...LASTED_BANDS.map(({ value }) => ({
      name: splitName(PUSH_ENDED_LASTED, value),
      of: { figure: PUSH_ENDED_LASTED, value, source: null },
      at: (minute: number) =>
        endedIn(minute).filter((stream) => lastedBandOf(stream) === value).length,
    })),
  ];
}

/** The name of the column that counts the slices that were down for some of each minute. */
export const SLICES_DOWN = 'slices_down';

/** How many slices of users were down for any part of each minute, from the windows the run recorded. */
export function slicesDownColumns(data: RunData): Column[] {
  const windows = data.manifest.slices.map(({ down }) => windowsInMs(down));
  return [
    {
      name: SLICES_DOWN,
      at: (minute) =>
        windows.filter((own) =>
          own.some(({ from, to }) => minute <= to && minute + MINUTE_MS > from),
        ).length,
    },
  ];
}

/** What the home machine did, from its samples. */
export function hostColumns(data: RunData): Column[] {
  return [
    { name: 'host_cpu_percent_max', at: maxInMinute(data.host, (sample) => sample.cpuPercent) },
    {
      name: 'memory_used_percent_max',
      at: maxInMinute(data.host, (sample) => sample.memoryUsedPercent),
    },
    {
      name: 'swap_used_mb_max',
      at: maxInMinute(data.host, (sample) => sample.swapUsedBytes / 1_000_000),
    },
    { name: 'load_average_1_max', at: maxInMinute(data.host, (sample) => sample.loadAverage1) },
  ];
}

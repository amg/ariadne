import {
  type AppRequestLine,
  type AppStateLine,
  REQUEST_KINDS,
  type RequestLine,
  type RequestOutcome,
  judgedVerdictOrNull,
} from '../../records/index.ts';
import { instantOf, minuteStartOf } from '../moments.ts';
import { compareText, distributionOf, maxOf, meanOf, roundTo } from '../numbers.ts';
import {
  REOPENED_WITHIN_MS,
  copyLabelsOf,
  endedPushStreamsOf,
  isOpenedPushStream,
  jobWaitMs,
  requestsOf,
} from '../runData/index.ts';
import { usersByMinute } from '../table/index.ts';
import type { RunData } from '../types.ts';
import { failureCounts } from './failures.ts';
import { insightsSummary } from './insights.ts';

/** What a request that no route took is counted under. */
const NO_ROUTE = 'no route';

/** Outcomes of a request that did its job, whose timings say how fast the app answers. */
const SERVED: readonly RequestOutcome[] = ['ok', 'streamed', 'held', 'dropped'];

/** Every count and percentile of the run, from its raw lines and never from running totals. */
export function summarize(data: RunData) {
  const requests = requestsOf(data);
  return {
    requests: {
      total: requests.length,
      byKind: Object.fromEntries(
        REQUEST_KINDS.filter((kind) => requests.some((line) => line.kind === kind)).map((kind) => [
          kind,
          kindSummary(requests.filter((line) => line.kind === kind)),
        ]),
      ),
      failures: failureCounts(data),
    },
    pushStreams: pushStreamsSummary(data),
    users: peakUsers(data),
    app: appSummary(data),
    host: hostSummary(data),
    insights: insightsSummary(data),
  };
}

function kindSummary(lines: readonly RequestLine[]) {
  const served = lines.filter((line) => SERVED.includes(line.outcome));
  return {
    count: lines.length,
    byOutcome: tally(lines, (line) => line.outcome),
    firstByteMs: distributionOf(served.map((line) => line.firstByteMs)),
    totalMs: distributionOf(served.map((line) => line.totalMs)),
  };
}

/** Counts the items by the key each one gives, with the keys in sorted order. */
function tally<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => compareText(a, b)));
}

function peakUsers(data: RunData) {
  const held = [...usersByMinute(data).values()];
  return {
    peakSignedIn: maxOf(held.map((users) => users.signedIn)) ?? 0,
    peakPushStreams: maxOf(held.map((users) => users.pushStreams)) ?? 0,
    peakChatters: maxOf(held.map((users) => users.chatters)) ?? 0,
  };
}

function appSummary(data: RunData) {
  const { exchanges, jobs, appStates } = data;
  return {
    exchanges:
      exchanges === null
        ? null
        : {
            count: exchanges.length,
            byOutcome: tally(exchanges, (line) => line.outcome),
            byVerdict: tally(exchanges, (line) =>
              line.verdictReplayed ? 'replayed' : (line.verdict ?? 'none'),
            ),
            verdictMs: distributionOf(
              exchanges.flatMap((line) =>
                judgedVerdictOrNull(line) === null ? [] : (line.verdictAfterMs ?? []),
              ),
            ),
            firstTokenMs: distributionOf(exchanges.flatMap((line) => line.firstTokenAfterMs ?? [])),
            endedMs: distributionOf(exchanges.map((line) => line.endedAfterMs)),
          },
    jobs:
      jobs === null
        ? null
        : {
            count: jobs.length,
            byTask: Object.fromEntries(
              Object.keys(tally(jobs, (job) => job.task)).map((task) => {
                const own = jobs.filter((job) => job.task === task);
                return [
                  task,
                  {
                    count: own.length,
                    failed: own.filter((job) => job.outcome !== 'succeeded').length,
                    waitMs: distributionOf(own.map(jobWaitMs)),
                    runMs: distributionOf(own.map((job) => job.durationMs)),
                  },
                ];
              }),
            ),
          },
    requests: requestsSummary(data.appRequests),
    peakPushStreams: maxOf(appStates?.flatMap((state) => state.pushStreamsOpen ?? []) ?? []),
    longestJobWaitMs: maxOf(appStates?.flatMap((state) => state.oldestJobWaitMs ?? []) ?? []),
    copies: copiesSummary(appStates ?? []),
    byCopy: byCopySummary(appStates ?? []),
  };
}

function byCopySummary(states: readonly AppStateLine[]) {
  return Object.fromEntries(
    [...copyLabelsOf(states)].map(([copy, label]) => {
      const own = states.filter((state) => state.copy === copy);
      return [
        label,
        {
          copy,
          ...copiesSummary(own),
          peakPushStreams: maxOf(own.flatMap((state) => state.pushStreamsOpen ?? [])),
          longestJobWaitMs: maxOf(own.flatMap((state) => state.oldestJobWaitMs ?? [])),
        },
      ];
    }),
  );
}

function pushStreamsSummary(data: RunData) {
  const opened = requestsOf(data).filter(isOpenedPushStream).length;
  const ended = endedPushStreamsOf(data);
  const byMinute = new Map<number, number>();
  for (const stream of ended) {
    const minute = minuteStartOf(stream.endedAt);
    byMinute.set(minute, (byMinute.get(minute) ?? 0) + 1);
  }
  const most = [...byMinute].reduce<[number, number] | null>(
    (top, entry) => (top === null || entry[1] > top[1] ? entry : top),
    null,
  );
  return {
    opened,
    endedEarly: ended.length,
    cut: ended.filter((stream) => stream.cut).length,
    reopened: ended.filter((stream) => stream.reopened).length,
    reopenedWithinSeconds: REOPENED_WITHIN_MS / 1_000,
    mostEndedInAMinute: most === null ? null : { minute: instantOf(most[0]), count: most[1] },
  };
}

function requestsSummary(appRequests: RunData['appRequests']) {
  if (appRequests === null) return null;
  const byRoute = new Map<string, AppRequestLine[]>();
  for (const line of appRequests) {
    const route = line.route ?? NO_ROUTE;
    byRoute.set(route, [...(byRoute.get(route) ?? []), line]);
  }
  return {
    count: appRequests.length,
    serverMs: distributionOf(appRequests.map((line) => line.durationMs)),
    byRoute: Object.fromEntries(
      [...byRoute]
        .sort(([a], [b]) => compareText(a, b))
        .map(([route, own]) => [
          route,
          {
            count: own.length,
            serverErrors: own.filter((line) => line.statusCode >= 500).length,
            serverMs: distributionOf(own.map((line) => line.durationMs)),
          },
        ]),
    ),
  };
}

function copiesSummary(states: readonly AppStateLine[]) {
  const worst = (pick: (state: AppStateLine) => number | null) =>
    maxOf(states.flatMap((state) => pick(state) ?? []));
  const failures = states.flatMap((state) => state.pushBusFailures ?? []);
  return {
    longestEventLoopDelayMs: worst((state) => state.eventLoopDelayP99Ms),
    peakHeapUsedBytes: worst((state) => state.heapUsedBytes),
    peakResidentBytes: worst((state) => state.residentBytes),
    peakDbConnectionsInUse: worst((state) => state.dbConnectionsInUse),
    peakDbConnectionsWaiting: worst((state) => state.dbConnectionsWaiting),
    peakWorkerSlotsBusy: worst((state) => state.workerSlotsBusy),
    workerSlots: worst((state) => state.workerSlots),
    pushBusFailures: failures.length === 0 ? null : failures.reduce((sum, count) => sum + count, 0),
  };
}

function hostSummary(data: RunData) {
  const samples = data.host ?? [];
  const cpu = samples.map((sample) => sample.cpuPercent);
  return {
    samples: samples.length,
    cpuPercent:
      samples.length === 0 ? null : { mean: roundTo(meanOf(cpu) ?? 0, 1), max: maxOf(cpu) ?? 0 },
    memoryUsedPercentMax: maxOf(samples.map((sample) => sample.memoryUsedPercent)),
    swapUsedBytesMax: maxOf(samples.map((sample) => sample.swapUsedBytes)),
    loadAverage1Max: maxOf(samples.map((sample) => sample.loadAverage1)),
  };
}

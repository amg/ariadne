import { z } from 'zod';
import type { JobLine, Manifest } from '../../records/index.ts';
import { MINUTE_MS, minuteStartOf } from '../moments.ts';
import type { RunData } from '../types.ts';

/** How long a job waited between being due and starting; never negative. */
export function jobWaitMs(job: Pick<JobLine, 'queuedAt' | 'startedAt'>) {
  return Math.max(0, Date.parse(job.startedAt) - Date.parse(job.queuedAt));
}

/**
 * When a run began and ended. A run that never recorded its end is read
 * up to the last moment any of its records mentions, and no earlier than
 * its start.
 */
export function runWindowOf(data: RunData) {
  const { manifest } = data;
  if (manifest.endedAt !== null) return { from: manifest.startedAt, to: manifest.endedAt };
  const moments = [
    manifest.startedAt,
    ...(data.events ?? []).map(({ at }) => at),
    ...manifest.slices.flatMap(({ endedAt }) => endedAt ?? []),
    ...data.slices.flatMap(({ requests, states }) => [
      ...(requests ?? []).map(({ startedAt }) => startedAt),
      ...(states ?? []).map(({ at }) => at),
    ]),
    ...[data.host, data.appStates].flatMap((samples) => (samples ?? []).map(({ at }) => at)),
    ...(data.exchanges ?? []).map(({ arrivedAt }) => arrivedAt),
    ...(data.jobs ?? []).map(({ finishedAt }) => finishedAt),
    ...(data.appRequests ?? []).map(({ endedAt }) => endedAt),
  ];
  return { from: manifest.startedAt, to: moments.reduce((last, at) => (at > last ? at : last)) };
}

/** The minutes a run spans, each as the millisecond its minute starts, oldest first. */
export function runMinutesOf(data: RunData) {
  const window = runWindowOf(data);
  const first = minuteStartOf(Date.parse(window.from));
  const last = minuteStartOf(Date.parse(window.to));
  const minutes: number[] = [];
  for (let minute = first; minute <= last; minute += MINUTE_MS) minutes.push(minute);
  return minutes;
}

/**
 * The minutes the run's charts and tables draw: the run's own, then those
 * of the stretch after its end when the run kept one. The first minute after
 * the run's own is where the stretch starts.
 */
export function drawnMinutesOf(data: RunData) {
  const own = runMinutesOf(data);
  if (data.afterRun === null) return { minutes: own, afterRunFrom: null };
  const last = own.at(-1) ?? minuteStartOf(Date.parse(data.afterRun.from));
  const lastDrawn = minuteStartOf(Date.parse(data.afterRun.to) - 1);
  const minutes = [...own];
  for (let minute = last + MINUTE_MS; minute <= lastDrawn; minute += MINUTE_MS)
    minutes.push(minute);
  return { minutes, afterRunFrom: last + MINUTE_MS };
}

/** The run's records with those of the stretch after its end put back, which are drawn and never judged. */
export function withAfterRun(data: RunData) {
  const { afterRun } = data;
  if (afterRun === null) return data;
  const joined = <Item>(
    inRun: readonly Item[] | null,
    after: readonly Item[] | null,
  ): readonly Item[] | null => (inRun === null ? null : [...inRun, ...(after ?? [])]);
  return {
    ...data,
    exchanges: joined(data.exchanges, afterRun.exchanges),
    jobs: joined(data.jobs, afterRun.jobs),
    appRequests: joined(data.appRequests, afterRun.appRequests),
    appStates: joined(data.appStates, afterRun.appStates),
  };
}

const cacheConfig = z.object({ cache: z.object({ maxEcpuPerSecond: z.number() }) });

/** The ECPU a second the run's step allowed the cache; null where the step's configuration does not say. */
export function cacheEcpuCapOrNull(manifest: Pick<Manifest, 'config'>) {
  const parsed = cacheConfig.safeParse(manifest.config);
  return parsed.success ? parsed.data.cache.maxEcpuPerSecond : null;
}

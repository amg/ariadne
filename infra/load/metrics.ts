/**
 * Counters and latency histograms, kept in fixed buckets so that the
 * reports of many generators add up into one: percentiles of a merged
 * run are read from the merged buckets.
 */

/** Upper bounds, in milliseconds; the last bucket holds everything slower. */
export const BUCKET_BOUNDS_MS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000,
] as const;

export type Histogram = { counts: number[] };

export type Report = {
  runId: string;
  generator: number;
  startedAt: string;
  endedAt: string;
  counters: Record<string, number>;
  histograms: Record<string, Histogram>;
};

export type Metrics = {
  count: (name: string, by?: number) => void;
  /** Tracks something that rises and falls, such as open push streams; reports its peak. */
  gauge: (name: string, change: number) => void;
  time: (name: string, milliseconds: number) => void;
  snapshot: () => Pick<Report, 'counters' | 'histograms'>;
};

export function createMetrics(): Metrics {
  const counters: Record<string, number> = {};
  const gauges: Record<string, number> = {};
  const histograms: Record<string, Histogram> = {};

  return {
    count(name, by = 1) {
      counters[name] = (counters[name] ?? 0) + by;
    },
    gauge(name, change) {
      const current = (gauges[name] ?? 0) + change;
      gauges[name] = current;
      counters[`${name}.peak`] = Math.max(counters[`${name}.peak`] ?? 0, current);
    },
    time(name, milliseconds) {
      const histogram = histograms[name] ?? emptyHistogram();
      histograms[name] = histogram;
      const bucket = bucketOf(milliseconds);
      histogram.counts[bucket] = (histogram.counts[bucket] ?? 0) + 1;
    },
    snapshot() {
      return { counters: { ...counters, ...gauges }, histograms: structuredClone(histograms) };
    },
  };
}

export function emptyHistogram(): Histogram {
  return { counts: new Array(BUCKET_BOUNDS_MS.length + 1).fill(0) };
}

/** The bucket bound below which `share` (0..1) of the samples fall; `Infinity` past the last bound. */
export function percentileMs(histogram: Histogram, share: number): number {
  const total = histogram.counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return 0;
  let seen = 0;
  for (const [index, count] of histogram.counts.entries()) {
    seen += count;
    if (seen >= total * share) return BUCKET_BOUNDS_MS[index] ?? Number.POSITIVE_INFINITY;
  }
  return Number.POSITIVE_INFINITY;
}

function bucketOf(milliseconds: number): number {
  const index = BUCKET_BOUNDS_MS.findIndex((bound) => milliseconds <= bound);
  return index === -1 ? BUCKET_BOUNDS_MS.length : index;
}

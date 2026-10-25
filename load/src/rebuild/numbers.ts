/** A value rounded to a number of decimal places, so that a figure reads the same on every machine. */
export function roundTo(value: number, places: number) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * The value that `share` (0..1) of the samples are at or under: the
 * smallest sample with at least that share of them at or below it. Null
 * when there are no samples.
 */
export function percentileOf(samples: readonly number[], share: number) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(sorted.length * share));
  return sorted[rank - 1] ?? null;
}

/** How a set of samples spreads: how many there are and where they sit. */
export type Distribution = {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

/** The spread of the samples, each figure rounded to a tenth; null when there are none. */
export function distributionOf(samples: readonly number[]) {
  const at = (share: number): number => roundTo(percentileOf(samples, share) ?? 0, 1);
  if (samples.length === 0) return null;
  return { count: samples.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}

export function maxOf(values: readonly number[]) {
  return values.length === 0 ? null : values.reduce((most, value) => Math.max(most, value));
}

export function meanOf(values: readonly number[]) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Orders text by its characters alone, so that a sorted list reads the same on every machine. */
export function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The percentiles a figure's spread is drawn with, each by name and share. */
export const PERCENTILES = [
  ['p50', 0.5],
  ['p95', 0.95],
  ['p99', 0.99],
] as const;

/** A part of a whole, as a percent to two places; null where either is unknown, or the whole is nothing. */
export function percentOrNull(part: number | null, whole: number | null) {
  if (part === null || whole === null || whole === 0) return null;
  return roundTo((part / whole) * 100, 2);
}

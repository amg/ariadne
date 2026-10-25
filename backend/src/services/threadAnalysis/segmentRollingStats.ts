/**
 * One segment's noise baseline: the running mean and sample standard
 * deviation of the readings the segment accepted. Callers judge a reading
 * before they add it, and add only readings that did not fire, so the
 * baseline never learns from the arrivals it turned away.
 */

/** The baseline's stored moments — the judgment-state checkpoint's baseline half. */
export interface BaselineSnapshot {
  count: number;
  /** The raw running mean; 0 while the count is 0 (`mean` reads null then). */
  mean: number;
  m2: number;
}

export function createSegmentRollingStats(from?: BaselineSnapshot) {
  let count = from?.count ?? 0;
  let mean = from?.mean ?? 0;
  let m2 = from?.m2 ?? 0;

  return {
    add(sample: number): void {
      count += 1;
      const delta = sample - mean;
      mean += delta / count;
      m2 += delta * (sample - mean);
    },
    get count(): number {
      return count;
    },
    get mean(): number | null {
      return count === 0 ? null : mean;
    },
    get std(): number | null {
      return count < 2 ? null : Math.sqrt(m2 / (count - 1));
    },
    get snapshot(): BaselineSnapshot {
      return { count, mean, m2 };
    },
  };
}

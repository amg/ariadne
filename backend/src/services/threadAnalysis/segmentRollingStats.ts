/**
 * One segment's noise baseline for the live gate: O(1) Welford running mean and SAMPLE standard
 * deviation over the fold-time readings of the segment's accepted
 * members only. Judge first, fold second — callers read `mean`/`std`
 * BEFORE `add`, so an arriving reading can never enter its own
 * criterion, and the replay only folds a reading after the verdict
 * ACCEPTED it: ratchet guard — nothing the verdict rejected ever enters
 * the moments, so a segment's tolerance can widen with its topic but can
 * never be infected by the arrivals it turned away. The sample σ
 * (dividing by n−1) is the deliberately conservative choice for baselines
 * of a handful of readings; a verdict shreds the baseline wholesale.
 */

/** The baseline's stored moments — the judgment-state checkpoint's baseline half. */
export interface BaselineSnapshot {
  count: number;
  /** The raw running mean; 0 while the count is 0 (`mean` reads null then). */
  mean: number;
  m2: number;
}

export interface SegmentRollingStats {
  /** Fold one accepted sample into the running moments. */
  add(sample: number): void;
  /** Accepted samples folded so far. */
  readonly count: number;
  /** Running mean of the folded samples; null before the first sample. */
  readonly mean: number | null;
  /** Sample standard deviation; null while fewer than two samples. */
  readonly std: number | null;
  /** The raw moments a checkpoint stores and a restore reads back — no derived round-trip. */
  readonly snapshot: BaselineSnapshot;
}

export function createSegmentRollingStats(from?: BaselineSnapshot): SegmentRollingStats {
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

/**
 * One segment's noise ledger for the live gate: O(1) Welford running mean and SAMPLE standard
 * deviation over the fold-time readings of the segment's accepted
 * members only. Judge first, fold second — callers read `mean`/`std`
 * BEFORE `add`, so an arriving reading can never enter its own
 * criterion, and the replay only folds a reading after the verdict
 * ACCEPTED it: ratchet guard — nothing the verdict rejected ever enters
 * the moments, so a segment's tolerance can widen with its topic but can
 * never be infected by the arrivals it turned away. The sample σ
 * (dividing by n−1) is the deliberately conservative choice for ledgers
 * of a handful of readings; a verdict shreds the ledger wholesale.
 */

export interface RollingStats {
  /** Fold one accepted sample into the running moments. */
  add(sample: number): void;
  /** Accepted samples folded so far. */
  readonly count: number;
  /** Running mean of the folded samples; null before the first sample. */
  readonly mean: number | null;
  /** Sample standard deviation; null while fewer than two samples. */
  readonly std: number | null;
}

export function createRollingStats(): RollingStats {
  let count = 0;
  let mean = 0;
  let m2 = 0;

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
  };
}

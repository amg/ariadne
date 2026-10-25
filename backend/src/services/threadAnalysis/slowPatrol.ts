/**
 * The slow channel's change detector: it fires once a stream of drift
 * readings has risen by a sustained amount, not on any single reading.
 * Rises smaller than the allowance never add up, and a fire resets the
 * detector, so the new level becomes its baseline.
 */

interface SlowPatrolOptions {
  /** λ, the fire budget: how far the accumulated rise must climb before the patrol fires, in drift units. */
  lambda: number;
  /** δ, the allowance: the per-reading rise ignored as noise, in drift units. */
  delta: number;
  /** Readings the patrol must see before any fire is admitted. */
  minSamples: number;
}

/** The patrol's stored accumulator — the judgment-state checkpoint's patrol half. */
export interface PatrolSnapshot {
  count: number;
  /** The samples' raw running total; the detector's mean derives as sum/count. */
  sum: number;
  cumulative: number;
  lowWater: number;
  /** The sample at the accumulator's lowest point; null while the patrol is empty. */
  lowWaterId: string | null;
}

/** What a fire reports: where the rise began. */
interface PatrolFire {
  /** The sample at the accumulator's lowest point, as it stood before the fire reset it. */
  lowWaterId: string | null;
}

interface SlowPatrol {
  /** Feeds one sample; the fire this sample causes, or null when it causes none. */
  update(input: { sample: number; sampleId: string }): PatrolFire | null;
  /**
   * Hard reset: the level after a verdict becomes the new baseline. The
   * immediate channel calls this when it catches a sharp flip first, so
   * the detector never adds up the spike.
   */
  reset(): void;
  /** The raw accumulator a checkpoint stores and a restore reads back — no derived round-trip. */
  readonly snapshot: PatrolSnapshot;
}

/** A patrol with the given options, empty or restored from a checkpoint. */
export function createSlowPatrol({
  lambda,
  delta,
  minSamples,
  from,
}: SlowPatrolOptions & { from: PatrolSnapshot | undefined }): SlowPatrol {
  let count = from?.count ?? 0;
  let sum = from?.sum ?? 0;
  let cumulative = from?.cumulative ?? 0;
  let lowWater = from?.lowWater ?? 0;
  let lowWaterSampleId = from?.lowWaterId ?? null;

  return {
    update({ sample, sampleId }) {
      // Page–Hinkley: the accumulator adds each sample's deviation from the
      // running mean, less δ. A fire needs it to climb λ above its own
      // lowest point.
      count += 1;
      sum += sample;
      const mean = sum / count;
      cumulative += sample - mean - delta;
      if (count <= minSamples || cumulative < lowWater) {
        lowWater = cumulative;
        lowWaterSampleId = sampleId;
      }
      const fired = count >= minSamples && cumulative - lowWater >= lambda;
      if (!fired) return null;
      const fire = { lowWaterId: lowWaterSampleId };
      this.reset();
      return fire;
    },
    reset(): void {
      count = 0;
      sum = 0;
      cumulative = 0;
      lowWater = 0;
      lowWaterSampleId = null;
    },
    get snapshot(): PatrolSnapshot {
      return { count, sum, cumulative, lowWater, lowWaterId: lowWaterSampleId };
    },
  };
}

/**
 * Page–Hinkley change detector: one-sided test for a sustained RISE in a streaming
 * signal. The slow patrol of the two-channel verdict over the Prospective
 * drift_p stream — unit-coherent with its input: the replay hands over
 * the RAW drift readings themselves (the same verdict-lane signal the
 * immediate channel judges — the rewritten-message reading where a
 * rewrite landed, the raw fallback otherwise), so λ is the fire budget
 * in DRIFT UNITS and δ the drift-unit allowance (≈ 0 on the corpus).
 * A z-standardized patrol input (λ_z in z-sums) shipped earlier the same
 * day and proved degenerate — the chasing baseline μ erased a gentle wander
 * from the signal and the σ floor amplified reading noise. State is O(1):
 * four scalars, nothing persisted.
 *
 * Mechanics: with the running mean m_n of the samples seen, accumulate
 * the deviation G = Σ (x_i − m_n − δ). Rises smaller than the allowance
 * δ never accumulate; fire once the rise G has climbed λ above its own
 * low-water mark. A fire resets the detector — the new regime becomes
 * its own baseline.
 */

export interface PageHinkleyOptions {
  /** λ (the gate patrol's fire budget, in drift units): fire once the accumulated rise reaches this. */
  lambda: number;
  /** δ (the gate patrol's allowance, in drift units): deviations below it are noise, not rise. */
  delta: number;
  /** Minimum samples before any fire is admitted. */
  minSamples: number;
}

export interface PageHinkleyDetector {
  /** Feed one sample; true when this sample fires a detection. */
  update(sample: number, sampleId: string): boolean;
  /**
   * Hard reset: the regime after a verdict becomes its own baseline
   *. The immediate channel fires this when it catches a sharp
   * flip first, so the accumulator never accumulates the spike.
   */
  reset(): void;
  /** The current accumulated rise above the low-water mark (inspection only). */
  readonly rise: number;
  /** Samples consumed since the last reset (cold start counts). */
  readonly sampleCount: number;
  /**
   * The running mean INCLUDING the most recent sample — the baseline this
   * thread taught the detector. Null before the first sample AND after an
   * external reset (an immediate-channel verdict clears the recording:
   * its spike was never consumed).
   */
  readonly lastMean: number | null;
  /**
   * The rise observed on the most recent sample, captured BEFORE a
   * fire-triggered reset — so a firing sample records its firing rise,
   * unlike `rise`, which reads 0 after the reset. Null before the first
   * sample and after an external reset. The chart series for the live
   * gate draws from these two.
   */
  readonly lastRise: number | null;
  /** The id of the sample that anchors the low-water mark. */
  readonly lowWaterId: string | null;
}

export function createPageHinkley(options: PageHinkleyOptions): PageHinkleyDetector {
  let count = 0;
  let sum = 0;
  let cumulative = 0;
  let lowWater = 0;
  let lowWaterIdValue: string | null = null;
  let lastMeanValue: number | null = null;
  let lastRiseValue: number | null = null;

  return {
    update(sample: number, sampleId: string): boolean {
      count += 1;
      sum += sample;
      const mean = sum / count;
      cumulative += sample - mean - options.delta;
      if (count === 1 || cumulative < lowWater) {
        lowWater = cumulative;
        lowWaterIdValue = sampleId;
      }
      lastMeanValue = mean;
      lastRiseValue = cumulative - lowWater;
      const fired = count >= options.minSamples && cumulative - lowWater >= options.lambda;
      if (!fired) return false;
      // Reset, then re-stamp the firing sample's own reading: a fire
      // records the rise that produced it, and keeps the mean the thread
      // taught the detector up to it.
      const riseAtFire = cumulative - lowWater;
      const meanAtFire = sum / count;
      this.reset();
      lastRiseValue = riseAtFire;
      lastMeanValue = meanAtFire;
      return true;
    },
    reset(): void {
      // A verdict clears the recording too: whatever prompted the reset
      // was never a sample this detector consumed (a fire re-stamps its
      // own reading after the reset — see above).
      count = 0;
      sum = 0;
      cumulative = 0;
      lowWater = 0;
      lowWaterIdValue = null;
      lastMeanValue = null;
      lastRiseValue = null;
    },
    get rise(): number {
      return cumulative - lowWater;
    },
    get sampleCount(): number {
      return count;
    },
    get lastMean(): number | null {
      return lastMeanValue;
    },
    get lastRise(): number | null {
      return lastRiseValue;
    },
    get lowWaterId(): string | null {
      return lowWaterIdValue;
    },
  };
}

import { describe, expect, it } from 'vitest';
import { createSegmentRollingStats } from './threadAnalysis/segmentRollingStats';
import { createSlowPatrol } from './threadAnalysis/slowPatrol';
import {
  JUDGING_DEFAULTS,
  createVerdictState,
  evaluateAndRecord,
  isColdStart,
} from './threadAnalysis/verdict';

type JudgingParams = typeof JUDGING_DEFAULTS;
type Judgment = ReturnType<typeof evaluateAndRecord>['judgment'];

/** The rise the detector has accumulated above its low-water mark. */
function riseOf(gate: ReturnType<typeof createSlowPatrol>) {
  return gate.snapshot.cumulative - gate.snapshot.lowWater;
}

describe('createSlowPatrol — the slow channel detector', () => {
  it('stays silent on a flat stream and fires on a sustained rise', () => {
    const gate = createSlowPatrol({
      lambda: 0.2,
      delta: 0.02,
      minSamples: 2,
      from: undefined,
    });
    for (const sample of [0.3, 0.31, 0.29, 0.3, 0.305]) {
      expect(gate.update({ sample, sampleId: 'test-id' })).toBeNull();
    }
    const verdicts = [0.62, 0.66, 0.7].map((sample) =>
      gate.update({ sample, sampleId: 'test-id' }),
    );
    expect(verdicts.some((fire) => fire !== null)).toBe(true);
  });

  it('names the sample at its lowest point with the fire, and nothing before it', () => {
    const gate = createSlowPatrol({ lambda: 0.2, delta: 0, minSamples: 2, from: undefined });
    const fires = [0.3, 0.3, 0.32, 0.5, 0.7, 0.9].map((sample, index) =>
      gate.update({ sample, sampleId: `sample-${index}` }),
    );
    // The warm-up keeps moving the lowest point until the second sample.
    expect(fires).toEqual([null, null, null, null, { lowWaterId: 'sample-1' }, null]);
  });

  it('is blind to rises smaller than δ', () => {
    const gate = createSlowPatrol({
      lambda: 0.05,
      delta: 0.1,
      minSamples: 2,
      from: undefined,
    });
    const verdicts = [0.3, 0.31, 0.35, 0.33, 0.32, 0.36].map((sample) =>
      gate.update({ sample, sampleId: 'test-id' }),
    );
    expect(verdicts).toEqual(new Array(6).fill(null));
  });

  it('respects minSamples before any fire is admitted', () => {
    const gate = createSlowPatrol({
      lambda: 0.01,
      delta: 0,
      minSamples: 4,
      from: undefined,
    });
    expect(gate.update({ sample: 0.1, sampleId: 'test-id' })).toBeNull();
    expect(gate.update({ sample: 0.1, sampleId: 'test-id' })).toBeNull();
    expect(gate.update({ sample: 0.9, sampleId: 'test-id' })).toBeNull(); // rising already, still locked
    expect(gate.update({ sample: 0.9, sampleId: 'test-id' })).toBeNull(); // sample 4: zeroes the baseline
    expect(gate.update({ sample: 0.9, sampleId: 'test-id' })).not.toBeNull(); // sample 5: admitted and firing
  });

  it('learns the new level after a fire: an equal rise does not re-fire', () => {
    const gate = createSlowPatrol({
      lambda: 0.2,
      delta: 0.02,
      minSamples: 2,
      from: undefined,
    });
    for (const sample of [0.3, 0.3, 0.75, 0.78, 0.8]) gate.update({ sample, sampleId: 'test-id' });
    expect(gate.snapshot.count).toBeLessThan(5);
    const verdicts = [0.8, 0.79, 0.81, 0.8].map((sample) =>
      gate.update({ sample, sampleId: 'test-id' }),
    );
    expect(verdicts).toEqual([null, null, null, null]);
  });

  it('an external reset empties the accumulator', () => {
    const gate = createSlowPatrol({
      lambda: 0.1,
      delta: 0.01,
      minSamples: 1,
      from: undefined,
    });
    gate.update({ sample: 0.1, sampleId: 'first' });
    gate.update({ sample: 0.2, sampleId: 'second' });
    gate.reset();
    expect(gate.snapshot).toEqual({
      count: 0,
      sum: 0,
      cumulative: 0,
      lowWater: 0,
      lowWaterId: null,
    });
  });

  it('accumulates a sustained creep and fires once the rise reaches λ, stays silent on ±0.04 noise', () => {
    const gate = createSlowPatrol({
      lambda: 0.5,
      delta: 0,
      minSamples: 3,
      from: undefined,
    });
    const noise = [0.3, 0.34, 0.26, 0.32, 0.28, 0.33, 0.27, 0.31, 0.29, 0.3].map((step) =>
      gate.update({ sample: step, sampleId: 'test-id' }),
    );
    expect(noise).toEqual(new Array(10).fill(null));

    // A quiet step, then +0.06 per turn: every step rises above the
    // detector's own running mean, so the rise grows until it fires.
    gate.reset();
    expect(gate.update({ sample: 0.3, sampleId: 'test-id' })).toBeNull();
    // A twin patrol that can never fire shows the rise each step reaches.
    const twin = createSlowPatrol({
      lambda: Number.POSITIVE_INFINITY,
      delta: 0,
      minSamples: 3,
      from: undefined,
    });
    twin.update({ sample: 0.3, sampleId: 'test-id' });
    const rises: number[] = [];
    const verdicts: boolean[] = [];
    for (let turn = 1; turn <= 8; turn += 1) {
      const sample = 0.3 + 0.06 * turn;
      const fired = gate.update({ sample, sampleId: 'test-id' });
      twin.update({ sample, sampleId: 'test-id' });
      rises.push(riseOf(twin));
      verdicts.push(fired !== null);
      if (fired) break;
    }
    expect(verdicts.filter((fired) => fired)).toHaveLength(1);
    expect(rises.every((rise, i) => i === 0 || rise >= (rises[i - 1] as number))).toBe(true);
    // Every step before the fire stayed under λ; the firing step reached it.
    expect(rises.slice(0, -1).every((rise) => rise < 0.5)).toBe(true);
    expect(rises.at(-1) as number).toBeGreaterThanOrEqual(0.5);
  });
});

describe('SegmentRollingStats — the immediate channel noise baseline', () => {
  it('folds Welford-style, mean from the first sample, SAMPLE std from the second', () => {
    const stats = createSegmentRollingStats();
    expect(stats.mean).toBeNull();
    expect(stats.std).toBeNull();
    stats.add(0.2);
    expect(stats.count).toBe(1);
    expect(stats.mean).toBeCloseTo(0.2);
    expect(stats.std).toBeNull();
    stats.add(0.6);
    expect(stats.mean).toBeCloseTo(0.4);
    // Sample σ divides by n−1: √(0.08/1) ≈ 0.2828, not the population's 0.2.
    expect(stats.std).toBeCloseTo(Math.sqrt(0.08), 10);
  });

  it('keeps moments honest over many mixed folds (sample variance)', () => {
    const stats = createSegmentRollingStats();
    const samples = [0.1, 0.5, 0.3, 0.9, 0.2, 0.4, 0.8, 0.6];
    for (const sample of samples) stats.add(sample);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance =
      samples.reduce((a, sample) => a + (sample - mean) * (sample - mean), 0) /
      (samples.length - 1);
    expect(stats.mean).toBeCloseTo(mean, 10);
    expect(stats.std).toBeCloseTo(Math.sqrt(variance), 10);
  });
});

describe('evaluateAndRecord — segment baseline, z verdict, verdict resets', () => {
  const params: JudgingParams = {
    coldStartTurns: 1,
    immediate: { stdDevs: 2, minStdDev: 0.02, bootstrapThreshold: 0.45 },
    slow: { fireBudget: 0.5, minRiseRequired: 0, minSamples: 2 },
  };

  /**
   * Judges one segment's readings in order, the slow channel reading the
   * same value as the immediate one.
   */
  function judgeReadings({ readings }: { readings: readonly number[] }): {
    judgments: Judgment[];
    state: ReturnType<typeof createVerdictState>;
  } {
    const state = createVerdictState(params);
    const judgments = readings.map(
      (reading, index) =>
        evaluateAndRecord({
          state,
          params,
          reading,
          anchorReading: reading,
          sampleId: `arrival-${index}`,
        }).judgment,
    );
    return { judgments, state };
  }

  it('floors a zero spread at σ_floor: a full-distance flip fires at once', () => {
    const { judgments, state } = judgeReadings({ readings: [0, 0, 1] });
    const flip = judgments[2];
    expect(flip?.fireChannel).toBe('immediate');
    expect(flip?.immediateThreshold).toBeCloseTo(0.04, 5);
    expect(flip?.immediateZ).toBeCloseTo(50, 3);
    expect(flip?.segmentMu).toBeCloseTo(0, 5);
    // The spike reaches neither the baseline nor the slow patrol.
    expect(state.baseline.count).toBe(0);
    expect(state.patrol.snapshot.count).toBe(0);
  });

  it('fires when the arrival clears μ + k·max(σ, σ_floor), passes just below', () => {
    // 0.30 and 0.32 → μ = 0.31, sample σ ≈ 0.0141 is below the floor, so
    // the criterion is μ + k·σ_floor = 0.35.
    const fire = judgeReadings({ readings: [0.3, 0.32, 0.355, 0.33] }).judgments;
    expect(fire.map((j) => j.fireChannel)).toEqual([null, null, 'immediate', null]);
    const spike = fire[2];
    expect(spike?.immediateThreshold).toBeCloseTo(0.35, 5);
    expect(spike?.immediateZ).toBeCloseTo(2.25, 4);
    // Judged against the baseline as it stood before the spike.
    expect(spike?.segmentMu).toBeCloseTo(0.31, 5);
    expect(spike?.segmentSigma).toBeCloseTo(0.01414, 4);
    // The verdict emptied the baseline: the next reading bootstraps again,
    // and the spike entered no baseline.
    const reseed = fire[3];
    expect(reseed?.immediateThreshold).toBeCloseTo(0.45, 5);
    expect(reseed?.immediateZ).toBeNull();
    expect(reseed?.segmentMu).toBeNull();
    expect(reseed?.segmentSigma).toBeNull();

    // The same segment with the arrival at z = 1.895: a pass, and it joins
    // the baseline the next reading is judged against.
    const pass = judgeReadings({ readings: [0.3, 0.32, 0.3479, 0.33] }).judgments;
    expect(pass.map((j) => j.fireChannel)).toEqual([null, null, null, null]);
    expect(pass[2]?.immediateZ).toBeCloseTo(1.895, 3);
    expect(pass[3]?.segmentMu).toBeCloseTo((0.3 + 0.32 + 0.3479) / 3, 5);
  });

  it('uses the baseline σ itself once it outgrows the floor', () => {
    // 0.30 and 0.40: μ = 0.35, sample σ ≈ 0.0707 sets the bar at ≈ 0.4914.
    const spread = judgeReadings({ readings: [0.3, 0.4, 0.5] }).judgments;
    expect(spread[2]?.fireChannel).toBe('immediate');
    expect(spread[2]?.immediateThreshold).toBeCloseTo(0.49142, 4);
    expect(spread[2]?.immediateZ).toBeCloseTo(2.1213, 3);
    expect(spread[2]?.segmentSigma).toBeCloseTo(0.07071, 4);
  });

  it('bootstraps on the flat threshold at 0 and 1 accepted members, and fires just above it', () => {
    const below = judgeReadings({ readings: [0.449, 0.445] }).judgments;
    expect(below.map((j) => j.fireChannel)).toEqual([null, null]);
    expect(below[0]?.immediateThreshold).toBeCloseTo(0.45, 5);
    expect(below[1]?.immediateThreshold).toBeCloseTo(0.45, 5);
    expect(below[1]?.segmentMu).toBeCloseTo(0.449, 5);
    expect(below[1]?.segmentSigma).toBeNull();

    const above = judgeReadings({ readings: [0.451] }).judgments;
    expect(above[0]?.fireChannel).toBe('immediate');
    expect(above[0]?.immediateZ).toBeNull();
  });

  it('a slow-channel verdict empties the baseline and the patrol', () => {
    const readings = [0.1, 0.1, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    const judging: JudgingParams = {
      ...params,
      immediate: { stdDevs: 3, minStdDev: 1.0, bootstrapThreshold: 0.99 },
      slow: { ...params.slow, fireBudget: 0.1 },
    };
    const state = createVerdictState(judging);
    // A twin patrol that never fires shows where the lowest point stood at each step.
    const twin = createSlowPatrol({
      lambda: Number.POSITIVE_INFINITY,
      delta: judging.slow.minRiseRequired,
      minSamples: judging.slow.minSamples,
      from: undefined,
    });
    let slowFire: Judgment | null = null;
    let lowestPointAtFire: string | null = null;
    for (const [index, reading] of readings.entries()) {
      twin.update({ sample: reading, sampleId: `arrival-${index}` });
      const { judgment } = evaluateAndRecord({
        state,
        params: judging,
        reading,
        anchorReading: reading,
        sampleId: `arrival-${index}`,
      });
      if (judgment.fireChannel === null) continue;
      slowFire = judgment;
      lowestPointAtFire = twin.snapshot.lowWaterId;
      break;
    }
    expect(slowFire?.fireChannel).toBe('slow');
    // The fire names the arrival at the patrol's lowest point, which the reset that follows erases.
    expect(lowestPointAtFire).not.toBeNull();
    expect(slowFire?.slowDriftStartMessageId).toBe(lowestPointAtFire);
    expect(state.baseline.count).toBe(0);
    expect(state.patrol.snapshot.count).toBe(0);
  });
});

describe('isColdStart — the mute policy', () => {
  const params: JudgingParams = { ...JUDGING_DEFAULTS, coldStartTurns: 2 };

  it('mutes every turn inside the cold start, however far the reading jumps', () => {
    expect(isColdStart(0, params, 1)).toBe(true);
    expect(isColdStart(1, params, 1)).toBe(true);
    expect(isColdStart(2, params, 1)).toBe(false);
  });

  it('mutes a turn with no reading', () => {
    expect(isColdStart(5, params, null)).toBe(true);
  });
});

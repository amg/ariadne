import type { FireChannel } from '@ari/lib/api/schemas/common/driftGate';
import { type BaselineSnapshot, createSegmentRollingStats } from './segmentRollingStats';
import { type PatrolSnapshot, createSlowPatrol } from './slowPatrol';
import type { JudgingParams } from './types';

type SlowPatrol = ReturnType<typeof createSlowPatrol>;

type SegmentRollingStats = ReturnType<typeof createSegmentRollingStats>;

/** The judging params every judgment uses. */
export const JUDGING_DEFAULTS: JudgingParams = {
  coldStartTurns: 1,
  immediate: { stdDevs: 2, minStdDev: 0.08, bootstrapThreshold: 0.52 },
  slow: { fireBudget: 0.15, minRiseRequired: 0.05, minSamples: 3 },
};

/**
 * The immediate channel's bookkeeping floor: a segment with fewer than 2
 * accepted members has no true spread yet, so `immediate.bootstrapThreshold`
 * judges until then. Separate from `slow.minSamples`, the slow channel's floor.
 */
const MIN_CRITERION_SAMPLES = 2;

/**
 * One judgment's audit trail: the fire channel (null when none fired),
 * the criterion level the reading was judged against, its z score, and
 * the segment baseline's μ/σ exactly as they stood at judgment, before
 * any fold or reset.
 */
interface Judgment {
  fireChannel: FireChannel | null;
  /** When fireChannel === 'slow', the arrival at the slow patrol's lowest point. */
  slowDriftStartMessageId: string | null;
  immediateThreshold: number;
  /** Null while the criterion bootstraps on `immediate.bootstrapThreshold` (baseline < 2). */
  immediateZ: number | null;
  /** Null while the baseline is empty (the bootstrap phase charts nothing). */
  segmentMu: number | null;
  /** Null while the baseline holds fewer than 2 accepted members. */
  segmentSigma: number | null;
}

/** Mutable verdict state threaded through a judging loop, one Turn at a time. */
interface VerdictState {
  /**
   * The CURRENT segment's noise baseline: rolling mean and sample spread
   * of the fold-time readings of accepted members only, folded only
   * AFTER the reading was judged and the verdict passed. A verdict
   * (either channel) shreds it wholesale — the rejected arrival that
   * starts the next segment seeds its geometry but never enters any
   * baseline, so the new baseline starts empty.
   */
  baseline: SegmentRollingStats;
  /** The slow patrol over the arrivals' Anchor distances. */
  patrol: SlowPatrol;
}

/**
 * One judged arrival's verdict state as its checkpoint stores it — the
 * exact baseline and patrol the NEXT arrival is judged from. Restoring
 * from it replays the same arithmetic a rebuild would: bit-identical
 * inputs, bit-identical judgments.
 */
interface JudgmentStateSnapshot {
  baseline: BaselineSnapshot;
  patrol: PatrolSnapshot;
}

export function createVerdictState(params: JudgingParams, from?: JudgmentStateSnapshot) {
  return {
    baseline: createSegmentRollingStats(from?.baseline),
    patrol: createSlowPatrol({
      lambda: params.slow.fireBudget,
      delta: params.slow.minRiseRequired,
      minSamples: params.slow.minSamples,
      from: from?.patrol,
    }),
  };
}

/** The verdict state as a checkpoint stores it. */
export function snapshotOfVerdictState(state: VerdictState) {
  return { baseline: state.baseline.snapshot, patrol: state.patrol.snapshot };
}

/**
 * The mute policy: turns inside the cold start get no verdict, and a
 * turn with no reading (nothing folded to measure it against yet) cannot
 * be judged.
 */
export function isColdStart(completedTurns: number, params: JudgingParams, reading: number | null) {
  return reading === null || completedTurns < params.coldStartTurns;
}

/** One reading to judge: the Gravity reading, its Anchor distance, and the arrival it belongs to. */
interface ReadingToJudge {
  state: VerdictState;
  params: JudgingParams;
  /** Segment drift: the reading the immediate channel judges. */
  reading: number;
  /** Anchor distance: the reading the slow channel accumulates. */
  anchorReading: number;
  /** The arrival's message id. */
  sampleId: string;
}

/**
 * The two-channel judgment for one sample, both channels standing on the
 * CURRENT segment's baseline.
 *
 * Immediate channel: standardize the arrival reading against the baseline —
 * z = (x − μ) / max(σ, σ_floor) — and fire at z ≥ k, the same call as
 * exceeding μ + k·max(σ, σ_floor). With fewer than MIN_CRITERION_SAMPLES
 * accepted members there is no true spread yet, so the flat T_segment
 * judges instead.
 *
 * Slow channel: feed the patrol the arrival's Anchor distance — how far
 * it sits from where the segment started — accumulated against the
 * patrol's own running mean, firing once the rise reaches λ. No baseline
 * standardization: a chasing baseline μ erases a gentle wander from the
 * signal, and σ_floor amplifies reading noise into it. The minimum-samples
 * floor mutes fires through the first steps.
 *
 * A verdict — either channel — shreds the baseline wholesale and
 * hard-resets the accumulator without consuming the spike: the rejected
 * arrival seeds the new segment's geometry but never enters any baseline,
 * so a baseline only ever learns from readings it accepted.
 */
function twoChannelJudge({
  state,
  params,
  reading,
  anchorReading,
  sampleId,
}: ReadingToJudge): Judgment {
  const mu = state.baseline.mean;
  const sigma = state.baseline.std;
  const k = params.immediate.stdDevs;
  const sigmaFloor = params.immediate.minStdDev;
  const bootstrapThreshold = params.immediate.bootstrapThreshold;
  const sigmaEff = Math.max(sigma ?? 0, sigmaFloor);
  const baselineWarm =
    mu !== null && sigma !== null && state.baseline.count >= MIN_CRITERION_SAMPLES;
  const immediateThreshold = baselineWarm ? mu + k * sigmaEff : bootstrapThreshold;
  const immediateZ = baselineWarm ? (reading - mu) / sigmaEff : null;
  const base = {
    immediateThreshold,
    immediateZ,
    segmentMu: mu,
    segmentSigma: sigma,
    slowDriftStartMessageId: null,
  };

  if (reading >= immediateThreshold) {
    // The arrival clears the segment's own noise level: verdict on the
    // spot. Shred the baseline, hard-reset the patrol — the spike is
    // consumed by neither.
    state.baseline = createSegmentRollingStats();
    state.patrol.reset();
    return { ...base, fireChannel: 'immediate' };
  }

  // The patrol takes every Anchor distance that did not fire the
  // immediate channel, from the very first: its own running mean is the
  // baseline, and the minimum-samples floor guards the fire.
  const slowFire = state.patrol.update({ sample: anchorReading, sampleId });
  if (slowFire) {
    // The accumulated rise reached λ (drift units): verdict. Shred the
    // baseline; the detector already reset itself in update().
    state.baseline = createSegmentRollingStats();
    return { ...base, fireChannel: 'slow', slowDriftStartMessageId: slowFire.lowWaterId };
  }

  return { ...base, fireChannel: null };
}

/**
 * The Drift gate's two-channel verdict on one reading. The immediate
 * channel judges the reading against the current segment's own noise
 * level. The slow channel fires on a sustained rise, and it speaks only
 * while the immediate channel stays silent. Any verdict clears the
 * segment's baseline, and a reading that fired never joins a baseline.
 *
 * Judge one reading against both channels, then accept-then-record it into
 * the segment baseline — a passing reading joins the segment's deciding
 * population; a rejected arrival never enters its OLD segment's baseline,
 * and the NEW segment's baseline starts empty of it too (its reading
 * measured the departure, not the new topic's noise).
 */
export function evaluateAndRecord(input: ReadingToJudge): { judgment: Judgment; fired: boolean } {
  const judgment = twoChannelJudge(input);
  const fired = judgment.fireChannel !== null;
  if (!fired) input.state.baseline.add(input.reading);
  return { judgment, fired };
}

import { type PageHinkleyDetector, createPageHinkley } from './pageHinkley';
import { type RollingStats, createRollingStats } from './rollingStats';

/**
 * The two-channel verdict core shared by both drift flows. The offline
 * fold and the gate replay run this exact judgment — they differ only in
 * the READING that feeds it: the fold feeds the complete-turn reading
 * (stored embedding vs the segment's Gravity point), the replay feeds the
 * composite prospective reading (expanded rewrite when the expansion tier
 * produced one, raw fallback otherwise).
 *
 * Mechanics, once:
 *  - every segment carries a noise ledger (rolling μ/σ over the readings
 *    of its ACCEPTED members, folded only after a reading was judged and
 *    passed — judge first, fold second);
 *  - the immediate channel standardizes the arrival against the ledger,
 *    z = (reading − μ) / max(σ, σ_floor), and fires at z ≥ immediateK;
 *  - while the ledger holds fewer than MIN_CRITERION_SAMPLES accepted
 *    members the flat T_segment bootstraps as the prior (the constant
 *    survives ONLY as this prior);
 *  - the slow channel is a Page–Hinkley patrol over the RAW drift
 *    readings against the detector's own running mean (λ, δ, minSamples)
 *    — it speaks only while the immediate channel stays silent;
 *  - any verdict shreds the ledger; an immediate fire hard-resets the
 *    patrol WITHOUT consuming the spike; a rejected arrival seeds the new
 *    segment's geometry but never enters any ledger (ratchet guard).
 */

/** The full two-channel judging parameter set, flat and shared. */
export interface JudgingParams {
  /**
   * T_segment — the bootstrap prior. Flat criterion that adjudicates
   * arrivals while the current segment's ledger holds fewer than
   * MIN_CRITERION_SAMPLES accepted members; the constant survives only
   * as this prior in both flows.
   */
  segmentThreshold: number;
  /** k_immediate: the immediate channel fires at z ≥ k. */
  immediateK: number;
  /** σ_floor: the divisor floor under the ledger's sample σ. */
  sigmaFloor: number;
  /** λ: the slow patrol's PageHinkley fire budget, in drift units. */
  lambda: number;
  /** δ: the slow patrol's allowance, in drift units. */
  delta: number;
  /** Minimum slow-channel samples before any fire is admitted. */
  minSamples: number;
  /** Completed turns during which the flow mutes (no verdicts). */
  coldStartTurns: number;
}

/** The PageHinkley options both the patrol and any counsel detector use. */
export function patrolOptions(params: JudgingParams) {
  return { lambda: params.lambda, delta: params.delta, minSamples: params.minSamples };
}

/**
 * The immediate channel's bookkeeping floor: a segment with fewer than 2
 * accepted members has no true spread yet, so the constant T_segment
 * adjudicates until then — the constant survives purely as this bootstrap
 * prior. Separate from `minSamples`, which stays the PageHinkley floor.
 */
export const MIN_CRITERION_SAMPLES = 2;

/**
 * One judgment's audit trail: the fire channel (null when none fired),
 * the criterion level the reading was judged against, its z score, the
 * segment ledger's μ/σ exactly as they stood at judgment — BEFORE any
 * fold, verdict reset or shred — and whether the patrol actually
 * consumed this reading as a step (its readings ride the point only
 * then: a verdict-shredded ledger hands over nothing, so the detector's
 * stale recording never leaks onto the first arrival of a new segment).
 */
export interface Judgment {
  fireChannel: 'immediate' | 'slow' | null;
  immediateThreshold: number;
  /** Null while the criterion bootstraps on T_segment (ledger < 2). */
  immediateZ: number | null;
  /** Null while the ledger is empty (the bootstrap phase charts nothing). */
  segmentMu: number | null;
  /** Null while the ledger holds fewer than 2 accepted members. */
  segmentSigma: number | null;
  /** True when the patrol consumed this reading as a raw drift step. */
  patrolConsumed: boolean;
}

/** Mutable verdict state threaded through a judging loop, one Turn at a time. */
export interface VerdictState {
  /**
   * The CURRENT segment's noise ledger: rolling mean and sample spread
   * of the fold-time readings of accepted members only, folded only
   * AFTER the reading was judged and the verdict passed. A verdict
   * (either channel) shreds it wholesale — the rejected arrival that
   * starts the next segment seeds its geometry but never enters any
   * ledger, so the new ledger starts empty.
   */
  ledger: RollingStats;
  /** The slow patrol over the raw drift readings. */
  patrol: PageHinkleyDetector;
}

export function createVerdictState(params: JudgingParams): VerdictState {
  return {
    ledger: createRollingStats(),
    patrol: createPageHinkley(patrolOptions(params)),
  };
}

/**
 * Shared mute policy: turns inside the cold start get no verdict, and a
 * turn with no reading (the opening seed of the fold, the pre-Gravity
 * Turn 1 of the replay) is unjudgeable by construction.
 */
export function mutedArrival(
  completedTurns: number,
  params: JudgingParams,
  reading: number | null,
): boolean {
  return reading === null || completedTurns < params.coldStartTurns;
}

/**
 * The two-channel judgment for one sample, both channels standing on the
 * CURRENT segment's ledger.
 *
 * Immediate channel: standardize the arrival reading against the ledger —
 * z = (x − μ) / max(σ, σ_floor) — and fire at z ≥ k_immediate,
 * algebraically the identical call as exceeding μ + k·max(σ, σ_floor).
 * With fewer than MIN_CRITERION_SAMPLES accepted members there is no true
 * spread yet: the flat T_segment takes over as the bootstrap prior.
 *
 * Slow channel: feed the patrol the RAW drift reading itself — the same
 * verdict-lane signal the immediate channel just judged — accumulated
 * against the detector's OWN running mean (unchanged PageHinkley
 * internals). No ledger standardization: a chasing ledger μ erases a
 * gentle wander from the signal, and the σ floor amplifies reading noise
 * into it. The patrol therefore warms from its first consumed step — the
 * detector's own mean handles it, and its minSamples floor mutes fires
 * through the first steps.
 *
 * A verdict — either channel — shreds the ledger wholesale and
 * hard-resets the accumulator without consuming the spike: the rejected
 * arrival seeds the new segment's geometry but never enters any ledger
 * (ratchet guard — the deciding population is made of blessed steps
 * only).
 */
export function twoChannelJudge(
  state: VerdictState,
  params: JudgingParams,
  reading: number,
): Judgment {
  const mu = state.ledger.mean;
  const sigma = state.ledger.std;
  const sigmaEff = Math.max(sigma ?? 0, params.sigmaFloor);
  const ledgerWarm = mu !== null && sigma !== null && state.ledger.count >= MIN_CRITERION_SAMPLES;
  const immediateThreshold = ledgerWarm
    ? mu + params.immediateK * sigmaEff
    : params.segmentThreshold;
  const immediateZ = ledgerWarm ? (reading - mu) / sigmaEff : null;
  const base = {
    immediateThreshold,
    immediateZ,
    segmentMu: mu,
    segmentSigma: sigma,
  };

  if (reading >= immediateThreshold) {
    // The arrival clears the segment's own noise level: verdict on the
    // spot. Shred the ledger, hard-reset the patrol — the spike is
    // consumed by neither.
    state.ledger = createRollingStats();
    state.patrol.reset();
    return { ...base, fireChannel: 'immediate', patrolConsumed: false };
  }

  // The patrol consumes the raw drift step verbatim — every accepted
  // reading, from the very first: its own running mean is the baseline,
  // the minSamples floor guards the fire.
  const firedSlow = state.patrol.update(reading);
  if (firedSlow) {
    // The accumulated rise reached λ (drift units): verdict. Shred the
    // ledger; the detector re-stamps its firing rise, then resets itself
    // in update().
    state.ledger = createRollingStats();
    return { ...base, fireChannel: 'slow', patrolConsumed: true };
  }

  return { ...base, fireChannel: null, patrolConsumed: true };
}

/**
 * Judge one reading against both channels, then accept-then-fold it into
 * the segment ledger — a passing reading joins the segment's deciding
 * population; a rejected arrival never enters its OLD segment's ledger,
 * and the NEW segment's ledger starts empty of it too (its reading
 * measured the departure, not the new topic's noise).
 */
export function judgeAndFold(
  state: VerdictState,
  params: JudgingParams,
  reading: number,
): { judgment: Judgment; fired: boolean } {
  const judgment = twoChannelJudge(state, params, reading);
  const fired = judgment.fireChannel !== null;
  if (!fired) state.ledger.add(reading);
  return { judgment, fired };
}

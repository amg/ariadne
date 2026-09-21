import { cosineDistance } from './drift';
import { createPageHinkley } from './pageHinkley';
import { createRollingStats } from './rollingStats';
import type {
  AnchorCounselRow,
  GateDivergenceRow,
  GateReplayParams,
  GateReplayPoint,
  GateVerdict,
} from './types';

/**
 * The pretend-replay logic for the two-channel
 * verdict: a stored Thread fed to the gate logic one incoming user
 * Message at a time, as if live. For every Turn: score its Prospective
 * vector (the empty-assistant Turn block of the incoming message)
 * against G_live — the Gravity point the fold carries INTO the Turn —
 * then fold the Turn itself through the same 006 rules
 * (preGravityByTurn carries that trajectory).
 *
 * The arrival reading is standardized
 * against the CURRENT SEGMENT'S own ledger — the mean μ and sample σ of
 * the fold-time readings of its ACCEPTED members, judge-first-fold-
 * second — and fires at z ≥ k_immediate. A verdict (either channel)
 * shrinks the ledger and hard-resets the slow accumulator without
 * consuming the spike: the rejected reading seeds the new segment's
 * geometry (the fold re-seeds Gravity) but never enters any ledger —
 * ratchet guard; the next segment's ledger starts empty and bootstraps
 * on the constant T_segment until two accepted members exist (the
 * constant survives ONLY as this prior). Slow channel: otherwise the RAW drift reading itself — the same
 * verdict-lane signal the immediate channel judges (the expansion
 * tier's rewritten user message when one landed, the raw arrival-time
 * text as fallback — the task) — feeds a per-Thread PageHinkley,
 * accumulated against the detector's OWN running mean — no ledger
 * standardization (the z-standardized original was a design error: the
 * chasing ledger μ erased a gentle wander from the signal, and the σ
 * floor amplified reading noise into it). It speaks only while the
 * immediate channel stays silent — the crawling class. The dual
 * reference withholds fires whose Prospective still sits near V_last
 * (adjustment-message class). Advisory only: the fold stays
 * authoritative on cuts, and divergence rows ("gate fired / fold found
 * nothing" and the reverse) are expected output — they are the
 * calibration data.
 */

export interface ScoreGateReplayProps {
  /** Complete Turns in replay order. */
  turnNumbers: number[];
  /** Transient Prospective vectors (never persisted), by Turn. */
  prospectiveVectorByTurn: Map<number, number[]>;
  /**
   * The expansion tier's vectors: rewritten Prospective
   * blocks embedded transiently. Sparse by construction — only the Turns
   * the tier rewrote carry one; every other Turn falls back to its raw
   * Prospective for the verdict signal.
   */
  expandedVectorByTurn?: Map<number, number[]>;
  /** The audit-trail texts behind `expandedVectorByTurn`, by Turn. */
  expandedTextByTurn?: Map<number, string>;
  /**
   * Expansion outcomes for Turns without an expanded vector: 'skip_no_candidate' | 'skip_rewrite_failed' |
   * 'skip_unusable_rewrite'. Absent entries stay unannotated ('off' mode:
   * the explanation is the mode itself — JSON stays byte-stable).
   */
  expansionNoteByTurn?: Partial<Record<number, string>> | undefined;
  /** Stored Turn vectors by Turn (keyed via the assistant Message). */
  turnVectorByTurn: Map<number, number[]>;
  /** The fold's live Gravity point each Turn was judged against. */
  preGravityByTurn: Map<number, number[] | null>;
  /** Turn numbers the fold cut as Boundary turns. */
  foldBoundaryTurns: Set<number>;
  /** The frozen Anchor (wander gauge — no classification vote). */
  anchorVector: number[];
  /** 1-based message numbers of the incoming user Messages. */
  userMessageIndexByTurn: Map<number, number>;
  /**
   * T_segment: the fold's charter constant — the immediate channel's
   * bootstrap criterion while the current segment's ledger is still
   * warming up (fewer than 2 accepted members), and the only criterion
   * the first segment's arrivals see under the cold start. The constant
   * survives in the live gate ONLY as this prior.
   */
  segmentThreshold: number;
  params: GateReplayParams;
}

export interface GateReplayScoring {
  points: GateReplayPoint[];
  divergences: GateDivergenceRow[];
  anchorCounsel: AnchorCounselRow[];
}

/** PageHinkley options come straight from the gate params. */
function detectors(params: GateReplayParams) {
  const options = { lambda: params.lambda, delta: params.delta, minSamples: params.minSamples };
  return {
    gate: createPageHinkley(options),
    // The Anchor-wander counsel reuses the same detector over the
    // prospective anchor-distance stream: anchor distance IS the
    // drift-trend equivalent — no new params, no vote.
    anchorCounsel: createPageHinkley(options),
  };
}

/** The verdict for one sampled Turn once the detectors have spoken. */
function verdictFor(args: {
  muted: boolean;
  fired: boolean;
  nearLastTurn: boolean;
}): GateVerdict {
  if (args.muted) return 'muted';
  if (!args.fired) return 'pass';
  return args.nearLastTurn ? 'withheld' : 'fire';
}

/** Gate-vs-fold disagreement rows: the replay's calibration output. */
function divergenceFor(turnNumber: number, verdict: GateVerdict, foldCut: boolean) {
  if (verdict === 'fire' && !foldCut) return { turnNumber, kind: 'gate_fired_fold_quiet' } as const;
  if (foldCut && verdict === 'withheld')
    return { turnNumber, kind: 'gate_withheld_fold_cut' } as const;
  if (foldCut && verdict !== 'fire') return { turnNumber, kind: 'fold_cut_gate_quiet' } as const;
  return null;
}

/** Mutable replay state threaded through the loop, one Turn at a time. */
interface ReplayState {
  gate: ReturnType<typeof createPageHinkley>;
  counsel: ReturnType<typeof createPageHinkley>;
  /**
   * The CURRENT segment's noise ledger: rolling mean and
   * sample spread of the fold-time readings of accepted members only,
   * folded only AFTER the reading was judged and the verdict passed.
   * A verdict (either channel) shrinks it wholesale — the rejected
   * arrival that starts the next segment seeds its geometry but never
   * enters any ledger, so the new ledger starts empty.
   */
  ledger: ReturnType<typeof createRollingStats>;
  points: GateReplayPoint[];
  divergences: GateDivergenceRow[];
  counselRows: AnchorCounselRow[];
  /** V_last: the last completed Turn's stored vector. */
  lastTurnVector: number[] | null;
  completedTurns: number;
}

/**
 * The verdict signal's vector for one Turn: the
 * rewritten Prospective when the expansion tier produced one, the raw
 * Prospective as fallback. Source is null when the tier did not run at
 * all — no annotation then (byte-stable 'off' JSON).
 */
function compositeVector(
  args: ScoreGateReplayProps,
  turnNumber: number,
): { vector: number[]; source: 'rewritten' | 'raw-fallback' | null } {
  const rewritten = args.expandedVectorByTurn?.get(turnNumber);
  if (rewritten) return { vector: rewritten, source: 'rewritten' };
  return {
    vector: args.prospectiveVectorByTurn.get(turnNumber) as number[],
    source: args.expandedVectorByTurn === undefined ? null : 'raw-fallback',
  };
}

/** Carries the rewritten text onto a scored point as its audit trail. */
function attachExpandedText(
  point: GateReplayPoint,
  args: ScoreGateReplayProps,
  turnNumber: number,
): void {
  const text = args.expandedTextByTurn?.get(turnNumber);
  if (text !== undefined) point.expandedText = text;
}

/**
 * Builds the scored point: core readings plus the two channels' audit
 * provenance (immediate criterion, fire channel). The slow channel's
 * own reading (gateMean/gateRise) rides it later, and only when the
 * accumulator actually consumed the sample; the rewritten-source note
 * carries the gate's own text and expansion annotations likewise.
 */
function buildPoint(params: {
  turnNumber: number;
  userMessageIndex: number;
  driftP: number | null;
  driftPGated: number | null;
  anchorDistance: number;
  verdict: GateVerdict;
  judgment: Judgment | null;
}): GateReplayPoint {
  const point: GateReplayPoint = {
    turnNumber: params.turnNumber,
    messageIndex: params.userMessageIndex,
    driftP: params.driftP,
    driftPGated: params.driftPGated,
    anchorDistance: params.anchorDistance,
    verdict: params.verdict,
  };
  const judgment = params.judgment;
  if (judgment !== null) {
    point.immediateThreshold = judgment.immediateThreshold;
    if (judgment.fireChannel !== null) point.fireChannel = judgment.fireChannel;
    if (judgment.immediateZ !== null) point.immediateZ = judgment.immediateZ;
    if (judgment.segmentMu !== null) {
      point.segmentMu = judgment.segmentMu;
      point.segmentSigma = judgment.segmentSigma;
    }
  }
  return point;
}

/**
 * Names which reading fed the verdict signal and annotates
 * any gap: the rewritten Prospective carries its audit text; the raw
 * fallback carries its skip reason. Runs without an expansion tier keep
 * their byte-stable JSON — no annotation at all.
 */
function annotateProvenance(
  point: GateReplayPoint,
  args: ScoreGateReplayProps,
  source: 'rewritten' | 'raw-fallback' | null,
  turnNumber: number,
  muted: boolean,
): void {
  if (source === 'rewritten') {
    point.driftPSource = source;
    attachExpandedText(point, args, turnNumber);
  } else if (source === 'raw-fallback') {
    point.driftPSource = source;
  }
  annotateExpansion(point, args.expansionNoteByTurn, muted);
}

/**
 * Explains a gap in the expanded series: the fold's mute
 * wins, a scored rewrite overrides a stale upstream note, otherwise the
 * upstream note carries. Runs without annotations at all ('off' mode,
 * legacy replays) keep their byte-stable JSON — no note set.
 */
function annotateExpansion(
  point: GateReplayPoint,
  expansionNoteByTurn: Partial<Record<number, string>> | undefined,
  muted: boolean,
): void {
  if (expansionNoteByTurn === undefined) return;
  const note = muted
    ? 'muted'
    : point.driftPSource === 'rewritten'
      ? 'rewrite'
      : expansionNoteByTurn[point.turnNumber];
  if (note !== undefined) point.expansionNote = note;
}

/**
 * Carries the slow detector's own reading at this sample — the patrol's
 * running mean of the raw drift steps it consumed and the accumulated
 * rise above low water, both in drift units —
 * onto the scored point verbatim, so the render half never re-derives
 * gate semantics. Recorded only when the accumulator actually consumed
 * the sample: muted Turns carry nothing and an immediate-channel fire
 * skips the accumulator (a spike draws no sustained rise).
 */
function attachGateReadings(
  point: GateReplayPoint,
  gate: ReturnType<typeof createPageHinkley>,
): void {
  const mean = gate.lastMean;
  const rise = gate.lastRise;
  if (mean !== null && rise !== null) {
    point.gateMean = mean;
    point.gateRise = rise;
  }
}

/**
 * The immediate channel's bookkeeping floor: a segment with
 * fewer than 2 accepted members has no true spread yet, so the constant
 * T_segment adjudicates until then — the constant survives purely as
 * this bootstrap prior. Separate from the gate params' `minSamples`,
 * which stays the PageHinkley floor (the split the task calls for).
 */
const MIN_CRITERION_SAMPLES = 2;

/**
 * One judgment's audit trail: the fire channel (null when none fired),
 * the criterion level the reading was judged against, its z score, the
 * segment ledger's μ/σ exactly as they stood at judgment — BEFORE any
 * fold, verdict reset or shred — and whether the patrol actually
 * consumed this reading as a step (its z-readings ride the point only
 * then: a verdict-shredded ledger hands over nothing, so the detector's
 * stale recording never leaks onto the first arrival of a new segment).
 */
interface Judgment {
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

/**
 * The two-channel judgment for one sample, both channels standing on the
 * CURRENT segment's ledger.
 *
 * Immediate channel: standardize the arrival reading against the ledger —
 * z = (x − μ) / max(σ, σ_floor) — and fire at z ≥ k_immediate,
 * algebraically the identical call as exceeding μ + k·max(σ, σ_floor).
 * With fewer than 2 accepted members there is no true spread yet: the
 * flat T_segment takes over as the bootstrap prior.
 *
 * Slow channel: feed the patrol the RAW drift
 * reading itself — the same verdict-lane signal the immediate channel
 * just judged — accumulated against the detector's OWN running mean
 * (unchanged PageHinkley internals). No ledger standardization: the
 * z-standardized original degenerated because the chasing ledger μ
 * erased a gentle wander from the signal and the σ floor amplified
 * reading noise. The patrol therefore warms from its first consumed
 * step — the detector's own mean handles it, and its minSamples floor
 * mutes fires through the first steps.
 *
 * A verdict — either channel — shrinks the ledger wholesale and
 * hard-resets the accumulator without consuming the spike: the rejected
 * arrival seeds the new segment's geometry but never enters any ledger
 * (ratchet guard — the deciding population is made of blessed steps
 * only).
 */
function twoChannelJudge(
  state: ReplayState,
  args: ScoreGateReplayProps,
  reading: number,
): Judgment {
  const mu = state.ledger.mean;
  const sigma = state.ledger.std;
  const sigmaEff = Math.max(sigma ?? 0, args.params.sigmaFloor);
  const ledgerWarm = mu !== null && sigma !== null && state.ledger.count >= MIN_CRITERION_SAMPLES;
  const immediateThreshold = ledgerWarm
    ? mu + args.params.immediateK * sigmaEff
    : args.segmentThreshold;
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
    state.gate.reset();
    return { ...base, fireChannel: 'immediate', patrolConsumed: false };
  }

  // The patrol consumes the RAW drift step verbatim — every accepted reading, from the very first: its own
  // running mean is the baseline, the minSamples floor guards the fire.
  const firedSlow = state.gate.update(reading);
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
 * The non-muted core of one replayed Turn: judge the composite reading
 * against both verdict channels, then accept-then-fold it into the
 * segment ledger — a passing reading joins the segment's deciding
 * population; a rejected arrival never enters its OLD segment's ledger,
 * and the NEW segment's ledger starts empty of it too (its reading
 * measured the departure, not the new topic's noise).
 */
function judgeAndFold(
  state: ReplayState,
  args: ScoreGateReplayProps,
  turnNumber: number,
  reading: number,
): { judgment: Judgment; fired: boolean } {
  const judgment = twoChannelJudge(state, args, reading);
  const fired = judgment.fireChannel !== null;
  if (!fired) state.ledger.add(reading);
  return { judgment, fired };
}

/** Replays one Turn: score its Prospective, verdict, divergence row. */
function replayTurn(state: ReplayState, args: ScoreGateReplayProps, turnNumber: number): void {
  const prospective = args.prospectiveVectorByTurn.get(turnNumber);
  const turnVector = args.turnVectorByTurn.get(turnNumber);
  if (!prospective || !turnVector) {
    throw new Error(`gate replay missing vectors for turn ${turnNumber}`);
  }

  const preGravity = args.preGravityByTurn.get(turnNumber) ?? null;
  const composite = compositeVector(args, turnNumber);
  const driftP = preGravity === null ? null : cosineDistance(prospective, preGravity);
  const driftPGated = preGravity === null ? null : cosineDistance(composite.vector, preGravity);
  const anchorDistance = cosineDistance(prospective, args.anchorVector);
  const muted = state.completedTurns < args.params.coldStartTurns || driftPGated === null;

  // The Anchor is Segment 1, so the wander reading exists from Turn 1 —
  // counsel sees every Turn, including the muted cold start; the gate's
  // verdicts only start where a reading can be judged.
  if (state.counsel.update(anchorDistance)) {
    state.counselRows.push({ turnNumber, anchorDistance });
  }

  let fired = false;
  let judgment: Judgment | null = null;
  if (!muted) {
    ({ judgment, fired } = judgeAndFold(state, args, turnNumber, driftPGated as number));
  }

  const nearLastTurn =
    state.lastTurnVector !== null &&
    cosineDistance(composite.vector, state.lastTurnVector) <= args.params.adjustmentRadius;
  const verdict = verdictFor({ muted, fired, nearLastTurn });

  // Build the point with both channels' audit provenance, then let the
  // slow reading ride it only when the accumulator consumed the sample.
  const point = buildPoint({
    turnNumber,
    userMessageIndex: args.userMessageIndexByTurn.get(turnNumber) ?? 0,
    driftP,
    driftPGated,
    anchorDistance,
    verdict,
    judgment,
  });
  // The patrol reading rides the point only when the detector actually
  // consumed this turn as a step — never on muted Turns, never on the
  // firing step of an immediate-channel verdict.
  if (!muted && (judgment as Judgment).patrolConsumed) attachGateReadings(point, state.gate);
  annotateProvenance(point, args, composite.source, turnNumber, muted);
  state.points.push(point);

  const divergence = divergenceFor(turnNumber, verdict, args.foldBoundaryTurns.has(turnNumber));
  if (divergence !== null) state.divergences.push(divergence);

  state.lastTurnVector = turnVector;
  state.completedTurns += 1;
}

export function scoreGateReplay(args: ScoreGateReplayProps): GateReplayScoring {
  const { gate, anchorCounsel: counsel } = detectors(args.params);
  const state: ReplayState = {
    gate,
    counsel,
    ledger: createRollingStats(),
    points: [],
    divergences: [],
    counselRows: [],
    lastTurnVector: null,
    completedTurns: 0,
  };

  for (const turnNumber of args.turnNumbers) {
    replayTurn(state, args, turnNumber);
  }

  return {
    points: state.points,
    divergences: state.divergences,
    anchorCounsel: state.counselRows,
  };
}

import { cosineDistance } from './drift';
import { type PageHinkleyDetector, createPageHinkley } from './pageHinkley';
import type { AnchorCounselRow, GateDivergenceRow, GateReplayPoint, GateVerdict } from './types';
import {
  type JudgingParams,
  type Judgment,
  type VerdictState,
  createVerdictState,
  evaluateAndRecord,
  isColdStart,
  patrolOptions,
} from './verdict';

/**
 * The pretend-replay logic for the two-channel
 * verdict: a stored Thread fed to the gate logic one incoming user
 * Message at a time, as if live. For every Turn: score its Prospective
 * vector (the empty-assistant Turn block of the incoming message)
 * against G_live — the Gravity point the fold carries INTO the Turn —
 * then fold the Turn itself through the same 006 rules
 * (preGravityByTurn carries that trajectory).
 *
 * The judging itself is the SHARED verdict core (`verdict.ts`) — the
 * same code the offline fold runs. The only replay-specific input is the
 * reading: the COMPOSITE PROSPECTIVE reading (the rewrite tier's
 * rewritten user message when one landed, the raw arrival-time text as
 * fallback). The core's mechanics live there: per-segment baseline, z ≥
 * k_immediate with T_segment as bootstrap prior, Page–Hinkley over the
 * raw readings, verdict shreds the baseline, immediate fires reset the
 * patrol without consuming the spike, rejected arrivals never enter any
 * baseline. Advisory only: the fold stays authoritative on cuts, and
 * divergence rows ("gate fired / fold found nothing" and the reverse)
 * are expected output — with identical judging logic on both sides they
 * can only come from the reading difference (user-only vs complete
 * exchange), which is precisely the calibration data.
 */

export interface ScoreGateReplayProps {
  /** Complete Turns in replay order. */
  turnNumbers: number[];
  /** Transient Prospective vectors (never persisted), by Turn. */
  prospectiveVectorByTurn: Map<number, number[]>;
  /**
   * The rewrite tier's vectors: rewritten Prospective
   * blocks embedded transiently. Sparse by construction — only the Turns
   * the tier rewrote carry one; every other Turn falls back to its raw
   * Prospective for the verdict signal.
   */
  rewrittenVectorByTurn?: Map<number, number[]>;
  /** The audit-trail texts behind `rewrittenVectorByTurn`, by Turn. */
  rewrittenTextByTurn?: Map<number, string>;
  /**
   * Expansion outcomes for Turns without an expanded vector: 'skip_no_candidate' | 'skip_rewrite_failed' |
   * 'skip_unusable_rewrite'. Absent entries stay unannotated ('off' mode:
   * the explanation is the mode itself — JSON stays byte-stable).
   */
  rewriteNoteByTurn?: Partial<Record<number, string>> | undefined;
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
   * The flat judging params — the shared two-channel verdict's full set,
   * identical to the fold's. T_segment survives in here ONLY as the
   * immediate channel's bootstrap prior while the current segment's
   * baseline warms up (fewer than 2 accepted members).
   */
  judging: JudgingParams;
}

export interface GateReplayScoring {
  points: GateReplayPoint[];
  divergences: GateDivergenceRow[];
  anchorCounsel: AnchorCounselRow[];
}

/** Verdict for one sampled Turn once the shared core has spoken. */
function verdictFor(args: { muted: boolean; fired: boolean }): GateVerdict {
  if (args.muted) return 'muted';
  return args.fired ? 'fire' : 'pass';
}

/** Gate-vs-fold disagreement rows: the replay's calibration output. */
function divergenceFor(turnNumber: number, verdict: GateVerdict, foldCut: boolean) {
  if (verdict === 'fire' && !foldCut) return { turnNumber, kind: 'gate_fired_fold_quiet' } as const;
  if (foldCut && verdict !== 'fire') return { turnNumber, kind: 'fold_cut_gate_quiet' } as const;
  return null;
}

/** Mutable replay state threaded through the loop, one Turn at a time. */
interface ReplayState {
  /** The shared two-channel verdict state (baseline + slow patrol). */
  verdict: VerdictState;
  /**
   * The Anchor-wander counsel detector: the same PageHinkley shape over
   * the prospective anchor-distance stream — anchor distance IS the
   * drift-trend equivalent. Advisory only: no new params, no vote.
   */
  counsel: PageHinkleyDetector;
  points: GateReplayPoint[];
  divergences: GateDivergenceRow[];
  counselRows: AnchorCounselRow[];
  completedTurns: number;
}

/**
 * The verdict signal's vector for one Turn: the
 * rewritten Prospective when the rewrite tier produced one, the raw
 * Prospective as fallback. Source is null when the tier did not run at
 * all — no annotation then (byte-stable 'off' JSON).
 */
function compositeVector(
  args: ScoreGateReplayProps,
  turnNumber: number,
): { vector: number[]; source: 'rewritten' | 'raw-fallback' | null } {
  const rewritten = args.rewrittenVectorByTurn?.get(turnNumber);
  if (rewritten) return { vector: rewritten, source: 'rewritten' };
  return {
    vector: args.prospectiveVectorByTurn.get(turnNumber) as number[],
    source: args.rewrittenVectorByTurn === undefined ? null : 'raw-fallback',
  };
}

/** Carries the rewritten text onto a scored point as its audit trail. */
function attachRewrittenText(
  point: GateReplayPoint,
  args: ScoreGateReplayProps,
  turnNumber: number,
): void {
  const text = args.rewrittenTextByTurn?.get(turnNumber);
  if (text !== undefined) point.rewrittenText = text;
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
 * fallback carries its skip reason. Runs without an rewrite tier keep
 * their byte-stable JSON — no annotation at all.
 */
function recordSignalSource(
  point: GateReplayPoint,
  args: ScoreGateReplayProps,
  source: 'rewritten' | 'raw-fallback' | null,
  turnNumber: number,
  muted: boolean,
): void {
  if (source === 'rewritten') {
    point.driftPSource = source;
    attachRewrittenText(point, args, turnNumber);
  } else if (source === 'raw-fallback') {
    point.driftPSource = source;
  }
  annotateExpansion(point, args.rewriteNoteByTurn, muted);
}

/**
 * Explains a gap in the expanded series: the fold's mute
 * wins, a scored rewrite overrides a stale upstream note, otherwise the
 * upstream note carries. Runs without annotations at all ('off' mode,
 * legacy replays) keep their byte-stable JSON — no note set.
 */
function annotateExpansion(
  point: GateReplayPoint,
  rewriteNoteByTurn: Partial<Record<number, string>> | undefined,
  muted: boolean,
): void {
  if (rewriteNoteByTurn === undefined) return;
  const note = muted
    ? 'muted'
    : point.driftPSource === 'rewritten'
      ? 'rewrite'
      : rewriteNoteByTurn[point.turnNumber];
  if (note !== undefined) point.rewriteNote = note;
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
function attachGateReadings(point: GateReplayPoint, verdict: VerdictState): void {
  const mean = verdict.patrol.lastMean;
  const rise = verdict.patrol.lastRise;
  if (mean !== null && rise !== null) {
    point.gateMean = mean;
    point.gateRise = rise;
  }
}

/**
 * Replays one Turn: score its Prospective, verdict, divergence row. The
 * judgment itself is the shared core's — this half only supplies the
 * composite prospective reading and records what the core returned.
 */
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
  const muted = isColdStart(state.completedTurns, args.judging, driftPGated);

  // The Anchor is Segment 1, so the wander reading exists from Turn 1 —
  // counsel sees every Turn, including the muted cold start; the gate's
  // verdicts only start where a reading can be judged.
  if (state.counsel.update(anchorDistance)) {
    state.counselRows.push({ turnNumber, anchorDistance });
  }

  let fired = false;
  let judgment: Judgment | null = null;
  if (!muted && driftPGated !== null) {
    ({ judgment, fired } = evaluateAndRecord(state.verdict, args.judging, driftPGated));
  }

  const verdict = verdictFor({ muted, fired });

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
  if (!muted && (judgment as Judgment).patrolConsumed) attachGateReadings(point, state.verdict);
  recordSignalSource(point, args, composite.source, turnNumber, muted);
  state.points.push(point);

  const divergence = divergenceFor(turnNumber, verdict, args.foldBoundaryTurns.has(turnNumber));
  if (divergence !== null) state.divergences.push(divergence);

  state.completedTurns += 1;
}

export function simulateGateReplay(args: ScoreGateReplayProps): GateReplayScoring {
  const state: ReplayState = {
    verdict: createVerdictState(args.judging),
    counsel: createPageHinkley(patrolOptions(args.judging)),
    points: [],
    divergences: [],
    counselRows: [],
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

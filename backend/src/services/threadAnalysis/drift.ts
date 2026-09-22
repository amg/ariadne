import { createPageHinkley } from './pageHinkley';
import type { Turn, TurnBlock } from './turns';
import type { AnchorCounselRow, DriftPoint, TopicSegment, TopicSegmentTurn } from './types';
import {
  type JudgingParams,
  type Judgment,
  type VerdictState,
  createVerdictState,
  judgeAndFold,
  mutedArrival,
  patrolOptions,
} from './verdict';

/**
 * Pure drift math (folder-private; verified through `analyzeThread`).
 * Key concepts: Anchor, Anchor distance, Segment drift,
 * Gravity point, Drift score, Boundary turn, Topic segment. Binds
 * Turn unit, Segment drift against a rolling Gravity point,
 * single-signal Drift score (clamped Segment drift), demoted Anchor
 * (charted series, no threshold, no classification role). All cosine math
 * runs in process over stored Turn vectors — no dependency on DB vector
 * operators, no API calls.
 */

/**
 * Clamps a value into [0, 1] — the Drift score range.
 * Purposeful: topic segmentation treats orthogonal (1.0) and opposite (2.0)
 * identically — both signal a topic boundary. Raw `segmentDrift` preserves
 * full [0, 2] cosine distance if future features need the distinction.
 */
function clampUnitInterval(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Cosine distance (1 − cosine similarity) between two vectors, computed
 * in process. Clamped to [0, 2]: float round-tripping through storage can
 * push the similarity fractionally past 1 for identical vectors.
 */
export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1; // degenerate zero vector: maximally distant
  return Math.min(2, Math.max(0, 1 - dot / denom));
}

/** Renormalizes to unit length; degenerate input is an error, never a directionless vector. */
function unitVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) throw new Error('centroid collapsed to zero');
  return vector.map((value) => value / norm);
}

/**
 * Equal-weight, element-wise-mean centroid, renormalized. Renormalizing
 * subsumes the division by the element count, so the mean's direction is
 * the sum's direction.
 */
export function centroid(vectors: number[][]): number[] {
  const first = vectors[0];
  if (!first) throw new Error('centroid requires at least one vector');
  const sum = new Array<number>(first.length).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < vector.length; i += 1) {
      sum[i] = (sum[i] ?? 0) + (vector[i] ?? 0);
    }
  }
  return unitVector(sum);
}

export interface ScoreDriftProps {
  /** Scored Turns, in Turn order (Turn 1 onward). */
  blocks: TurnBlock[];
  /** All complete Turns, for segment labels (first user message). */
  turns: Turn[];
  /** Stored Turn vectors keyed to the Turn's assistant message. */
  vectorByMessageId: Map<string, number[]>;
  /** 1-based message numbers (shared chart axis) keyed by message id. */
  messageIndexByMessageId: Map<string, number>;
  /** The flat two-channel judging params (shared with the gate replay). */
  judging: JudgingParams;
}

export interface DriftScoring {
  driftSeries: DriftPoint[];
  /** Turn range the Anchor was built from — provenance, never the vector. */
  anchorBuiltFromTurns: [number, number];
  /** The Anchor itself — folder-private carry for the gate replay. */
  anchorVector: number[];
  /**
   * The live Gravity point each Turn was judged against: the unit member
   * sum BEFORE the Turn folded in. Null only for the first Turn (no
   * Gravity point exists yet) — the gate replay's G_live at arrival.
   */
  preGravityByTurn: Map<number, number[] | null>;
  segments: TopicSegment[];
  /**
   * Anchor-wander counsel (fold-based): Page–Hinkley over the complete
   * turns' anchor distances. Advisory rows only — never a cut, never a
   * classification vote.
   */
  counsel: AnchorCounselRow[];
}

/** The stored vector behind a Turn block; a missing row is a bug, not data. */
function vectorFor(block: TurnBlock, vectorByMessageId: Map<string, number[]>): number[] {
  const vector = vectorByMessageId.get(block.assistantMessage.id);
  if (!vector) {
    throw new Error(`missing stored embedding for turn message ${block.assistantMessage.id}`);
  }
  return vector;
}

function buildSegment(
  index: number,
  fromTurn: number,
  toTurn: number,
  boundaryTurnNumber: number | null,
  label: string,
  turns: TopicSegmentTurn[],
): TopicSegment {
  return { index, fromTurn, toTurn, boundaryTurnNumber, label, turns };
}

/** Adds the member vector into the segment's element-wise running sum. */
function accumulate(sum: number[], vector: number[]): number[] {
  for (let i = 0; i < sum.length; i += 1) {
    sum[i] = (sum[i] ?? 0) + (vector[i] ?? 0);
  }
  return sum;
}

/** Mutable fold state threaded through the scoring loop. */
interface DriftFold {
  driftSeries: DriftPoint[];
  segments: TopicSegment[];
  segmentStart: number;
  openingBoundary: number | null;
  /**
   * Element-wise sum of the current segment's member vectors; its unit
   * vector is the Gravity point. Null until the first Turn seeds the
   * opening segment.
   */
  memberSum: number[] | null;
  /** The pre-judge Gravity snapshot per Turn (G_live at arrival time). */
  preGravityByTurn: Map<number, number[] | null>;
  /** The shared two-channel verdict state (segment ledger + slow patrol). */
  verdict: VerdictState;
  /** Complete turns processed before the current one (the mute counter). */
  completedTurns: number;
}

/** The segment's Turn content rows, in Turn order. */
function segmentTurnRows(
  contentByTurn: Map<number, TopicSegmentTurn>,
  fromTurn: number,
  toTurn: number,
): TopicSegmentTurn[] {
  const rows: TopicSegmentTurn[] = [];
  for (let turnNumber = fromTurn; turnNumber <= toTurn; turnNumber += 1) {
    const row = contentByTurn.get(turnNumber);
    if (row) rows.push(row);
  }
  return rows;
}

/** Closes the current segment through `toTurn`, opening the next at `nextFromTurn`. */
function closeCurrentSegment(
  fold: DriftFold,
  context: ScoreBlockContext,
  toTurn: number,
  nextFromTurn: number,
): void {
  fold.segments.push(
    buildSegment(
      fold.segments.length + 1,
      fold.segmentStart,
      toTurn,
      fold.openingBoundary,
      context.labelByTurn.get(fold.segmentStart) ?? '',
      segmentTurnRows(context.contentByTurn, fold.segmentStart, toTurn),
    ),
  );
  fold.segmentStart = nextFromTurn;
  fold.openingBoundary = nextFromTurn;
}

interface ScoreBlockContext {
  judging: JudgingParams;
  messageIndexByMessageId: Map<string, number>;
  labelByTurn: Map<number, string>;
  contentByTurn: Map<number, TopicSegmentTurn>;
}

/**
 * Judge first, fold second, for one Turn: score it against the current
 * Gravity point (Segment drift), then run the shared two-channel verdict
 * on the complete-turn reading — judge against the segment's OWN state:
 * the immediate channel standardizes the arrival against the ledger
 * (μ/max(σ, σ_floor), the flat T_segment bootstraps as the prior while
 * the ledger holds fewer than 2 accepted members) and fires at
 * z ≥ k_immediate; the slow patrol rides the same raw readings against
 * its own running mean and fires at a λ-budgeted sustained rise. A fire
 * from EITHER channel is a Boundary turn ('segment' — sharp flip,
 * 'slow' — crawling class): it closes the segment, shreds the ledger,
 * hard-resets the patrol without consuming the spike, and reseeds the
 * next Gravity point with the Turn's own vector — which seeds the
 * segment's geometry but never enters any ledger (ratchet guard). A
 * muted arrival (cold start; the opening seed carries no reading) folds
 * into the member sum but into no ledger.
 */
/**
 * The judgment's audit trail onto the fold's own point — a Boundary turn
 * also carries the channel that cut.
 */
function stampJudgment(
  point: DriftPoint,
  judgment: Judgment,
  verdict: VerdictState,
  fired: boolean,
): void {
  point.immediateThreshold = judgment.immediateThreshold;
  if (judgment.fireChannel !== null) point.fireChannel = judgment.fireChannel;
  if (judgment.immediateZ !== null) point.immediateZ = judgment.immediateZ;
  if (judgment.segmentMu !== null) point.segmentMu = judgment.segmentMu;
  if (judgment.segmentSigma !== null) point.segmentSigma = judgment.segmentSigma;
  if (judgment.patrolConsumed) {
    const mean = verdict.patrol.lastMean;
    const rise = verdict.patrol.lastRise;
    if (mean !== null && rise !== null) {
      point.gateMean = mean;
      point.gateRise = rise;
    }
  }
  if (fired) {
    point.isBoundary = true;
    point.boundaryReason = judgment.fireChannel === 'slow' ? 'slow' : 'segment';
  }
}

function scoreBlock(
  fold: DriftFold,
  context: ScoreBlockContext,
  block: TurnBlock,
  vector: number[],
): void {
  // Snapshot the live Gravity point before judging — the gate replay's
  // G_live at the moment this Turn's user Message arrived.
  const gravity = fold.memberSum === null ? null : unitVector(fold.memberSum);
  fold.preGravityByTurn.set(block.turnNumber, gravity);
  const segmentDrift = gravity === null ? null : cosineDistance(vector, gravity);
  const muted = mutedArrival(fold.completedTurns, context.judging, segmentDrift);

  const point: DriftPoint = {
    turnNumber: block.turnNumber,
    messageIndex: context.messageIndexByMessageId.get(block.assistantMessage.id) ?? 0,
    // Filled after the fold: the Anchor is Segment 1, unknown until the
    // segments exist.
    anchorDistance: 0,
    segmentDrift,
    driftScore: clampUnitInterval(segmentDrift ?? 0),
    isBoundary: false,
    boundaryReason: null,
  };

  if (!muted && segmentDrift !== null) {
    const { judgment, fired } = judgeAndFold(fold.verdict, context.judging, segmentDrift);
    stampJudgment(point, judgment, fold.verdict, fired);
  }

  fold.driftSeries.push(point);

  if (point.isBoundary) {
    closeCurrentSegment(fold, context, block.turnNumber - 1, block.turnNumber);
  }
  fold.memberSum =
    point.isBoundary || fold.memberSum === null ? [...vector] : accumulate(fold.memberSum, vector);
  fold.completedTurns += 1;
}

/**
 * The Anchor IS Segment 1: the centroid of the opening segment's member
 * Turns, frozen when Segment 1 closes (a flip at Turn 2 leaves it as
 * Turn 1 alone). Segment 1 is always defined — even when it stays open
 * for the whole Thread — so the Anchor always exists; its member set is
 * simply whatever the fold left in the opening segment. Built once, from
 * nothing else: a late cut makes it the whole opening topic, an early
 * flip keeps it pure.
 */
function buildSegment1Anchor(
  blocks: TurnBlock[],
  vectorByMessageId: Map<string, number[]>,
  segment1: TopicSegment,
): { vector: number[]; builtFromTurns: [number, number] } {
  const memberBlocks = blocks.filter(
    (block) => block.turnNumber >= segment1.fromTurn && block.turnNumber <= segment1.toTurn,
  );
  if (memberBlocks.length === 0) throw new Error('the opening segment has no members');
  const lastTurnNumber = memberBlocks[memberBlocks.length - 1]?.turnNumber ?? segment1.fromTurn;
  return {
    vector: centroid(memberBlocks.map((block) => vectorFor(block, vectorByMessageId))),
    builtFromTurns: [segment1.fromTurn, lastTurnNumber],
  };
}

/**
 * The fold that scores Segment drift and cuts Topic segments
 *: judge first, fold second. Each Topic segment carries a
 * rolling Gravity point — the equal-weight centroid of its member Turn
 * vectors. A Turn's Segment drift is its cosine distance from the
 * current Gravity point; the SHARED two-channel verdict judges it
 * against the segment's own state — the immediate channel (z ≥
 * k_immediate over the segment ledger, T_segment as bootstrap prior)
 * and the slow patrol (Page–Hinkley over the raw readings at λ) — and a
 * fire from either channel makes it a Boundary turn that closes the
 * segment and reseeds the next Gravity point with the Turn's own
 * vector, otherwise the Turn joins and folds in. The opening
 * segment's first Turn seeds the Gravity point and carries no score
 * (null, clamped to 0 in the Drift score). The Anchor IS Segment 1: the
 * fold decides the member set, then the Anchor is built from it — pure
 * opening topic, frozen at Segment 1's cut (or, when nothing cuts, the
 * whole opening theme). It stays demoted: no threshold, no
 * classification role — only the charted wander series and the slow
 * drift counsel.
 */
export function scoreDrift({
  blocks,
  turns,
  vectorByMessageId,
  messageIndexByMessageId,
  judging,
}: ScoreDriftProps): DriftScoring {
  const firstBlock = blocks[0];
  const lastBlock = blocks[blocks.length - 1];
  if (!firstBlock || !lastBlock) throw new Error('drift scoring needs at least one turn');

  const context: ScoreBlockContext = {
    judging,
    messageIndexByMessageId,
    labelByTurn: new Map(turns.map((turn) => [turn.turnNumber, turn.userMessage.content])),
    contentByTurn: new Map(
      turns.map((turn) => [
        turn.turnNumber,
        {
          turnNumber: turn.turnNumber,
          userContent: turn.userMessage.content,
          assistantContent: turn.assistantMessage === null ? null : turn.assistantMessage.content,
        },
      ]),
    ),
  };

  const fold: DriftFold = {
    driftSeries: [],
    segments: [],
    segmentStart: firstBlock.turnNumber,
    openingBoundary: null,
    memberSum: null,
    preGravityByTurn: new Map(),
    verdict: createVerdictState(judging),
    completedTurns: 0,
  };

  const vectorByTurn = new Map<number, number[]>();
  for (const block of blocks) {
    const vector = vectorFor(block, vectorByMessageId);
    vectorByTurn.set(block.turnNumber, vector);
    scoreBlock(fold, context, block, vector);
  }
  fold.segments.push(
    buildSegment(
      fold.segments.length + 1,
      fold.segmentStart,
      lastBlock.turnNumber,
      fold.openingBoundary,
      context.labelByTurn.get(fold.segmentStart) ?? '',
      segmentTurnRows(context.contentByTurn, fold.segmentStart, lastBlock.turnNumber),
    ),
  );

  // The fold is settled — Segment 1 is known, so the Anchor can be born:
  // build it from the opening segment, then stamp every point's wander
  // from it.
  const segment1 = fold.segments[0];
  if (!segment1) throw new Error('the fold produced no segments');
  const anchor = buildSegment1Anchor(blocks, vectorByMessageId, segment1);
  for (const point of fold.driftSeries) {
    const vector = vectorByTurn.get(point.turnNumber);
    if (!vector) throw new Error(`missing Turn vector for turn ${point.turnNumber}`);
    point.anchorDistance = cosineDistance(vector, anchor.vector);
  }

  // Anchor-wander counsel (fold side): Page–Hinkley over the complete
  // turns' anchor distances — the Anchor is born after the fold, so the
  // patrol walks the wander series once the distances exist. Advisory
  // only: never a cut, never a classification vote. Cold start does not
  // apply — the Anchor is Segment 1, so the wander reading exists from
  // Turn 1 and the counsel watches every Turn.
  const counselDetector = createPageHinkley(patrolOptions(judging));
  const counselRows: AnchorCounselRow[] = [];
  for (const point of fold.driftSeries) {
    if (counselDetector.update(point.anchorDistance)) {
      counselRows.push({ turnNumber: point.turnNumber, anchorDistance: point.anchorDistance });
    }
  }

  return {
    driftSeries: fold.driftSeries,
    anchorBuiltFromTurns: anchor.builtFromTurns,
    anchorVector: anchor.vector,
    preGravityByTurn: fold.preGravityByTurn,
    segments: fold.segments,
    counsel: counselRows,
  };
}

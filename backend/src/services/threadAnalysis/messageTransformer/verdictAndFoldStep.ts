import { randomUUID } from 'node:crypto';
import type { FireChannel, GateVerdict } from '@ari/lib/api/schemas/common/driftGate';
import type { ThreadAnalysisMode } from '@ari/lib/api/schemas/threads/analysis';
import type {
  ArrivalJudgmentState,
  Message,
  NewArrivalJudgmentState,
  NewSegmentDriftLog,
  TurnFold,
} from '@db/types';
import { findArrivalJudgmentStateOrNull } from '@queries/arrivalJudgmentStates/findArrivalJudgmentStateOrNull';
import { recordMessageEmbedding } from '@queries/messageEmbeddings/recordMessageEmbedding';
import { appendArrivalVerdict } from '@queries/segmentDriftLogs/appendArrivalVerdict';
import { findTurnFoldOrNull } from '@queries/turnFolds/findTurnFoldOrNull';
import { insertTurnFoldIfAbsent } from '@queries/turnFolds/insertTurnFoldIfAbsent';
import { type Result, err, ok } from '../../../types/result';
import { EMBEDDING_MODEL_ID, computeEmbeddingCostUsd, embedText } from '../../aiService';
import { type Turn, formattedTurn } from '../turns';
import type { JudgingParams, LiveArrival, LiveChain } from '../types';
import { cosineDistance } from '../vectors';
import {
  JUDGING_DEFAULTS,
  createVerdictState,
  evaluateAndRecord,
  isColdStart,
  snapshotOfVerdictState,
} from '../verdict';
import {
  arrivalAt,
  completedTurnsBefore,
  isArrivalFinished,
  positionOf,
  readLiveChain,
  readLiveTail,
  readStoredJudgments,
  storedVectorAndChainOrNull,
  withEmbedding,
  withEveryVector,
  withJudgment,
} from './liveChain';
import type { MessageStep } from './messageStep';

type JudgmentStateSnapshot = NonNullable<ReturnType<typeof snapshotOfVerdictState>>;

type KeptCheckpoints = Parameters<typeof appendArrivalVerdict>[0]['keep'];

type OpenedSegment = Parameters<typeof appendArrivalVerdict>[0]['openedSegments'][number];

/**
 * Verdict-and-fold step: judges the arrival against the current segment's
 * Gravity point, starts a fresh segment on a fire, and folds completed
 * Turns into that Gravity point. A judgment starts from the previous
 * arrival's stored checkpoints, so it costs the same however long the
 * Thread grows. The step cannot fail open: a missing embedding fails the
 * exchange, and the retry resumes the pass.
 */

/**
 * The segment's geometry one folded Turn leaves behind — the fold a
 * checkpoint stores and the next judgment measures against.
 */
interface TurnFoldValues {
  /** Elementwise sum of the segment's folded Turn vectors; its unit vector is the Gravity point. */
  gravitySum: number[];
  /** Sum of the segment's first up-to-three folded Turn vectors — the anchor reading's base. */
  anchorSum: number[];
  /** How many Turn vectors the anchor sum holds (1–3). */
  anchorCount: number;
  /** Complete Turns the live chain has folded through this Turn. */
  completedTurns: number;
  /** The segment the conversation sits in once this Turn folded. */
  segmentId: string;
}

/**
 * The gate's running state one pass carries. The checkpointed judgment
 * builds it from the stored checkpoints; the rebuild walks the stored
 * rows into it. Either way it never leaves the pass.
 */
interface RunningGateState {
  judging: JudgingParams;
  /** Shared two-channel verdict state: segment baseline + slow sweep. */
  verdictState: ReturnType<typeof createVerdictState>;
  /**
   * Elementwise sum of the current segment's folded turn vectors; its unit
   * vector is the gravity point that upcoming arrivals are measured
   * against. Null until the segment folds at least one complete turn.
   */
  memberSum: number[] | null;
  /**
   * Sum of the first up-to-three folded turn vectors of the current
   * segment; used as the anchor for the drift channel. Unit-normalized at
   * use.
   */
  currentSegmentAnchor: number[] | null;
  anchorMemberCount: number;
  /** Number of complete turns folded so far — the cold-start mute counter. */
  completedTurns: number;
  /** The segment row the next verdict logs against. */
  currentSegmentId: string | null;
}

/** A walk's last folded Turns, newest last — the folds it writes on its way out. */
interface FoldedTurn {
  assistantMessageId: string;
  values: TurnFoldValues;
}

/** The arrival's judgment against the current segment baseline. */
interface ArrivedJudgment {
  muted: boolean;
  fired: boolean;
  fireChannel: FireChannel | null;
  slowDriftStartMessageId: string | null;
  driftP: number | null;
  segmentMu: number | null;
  segmentSigma: number | null;
  immediateZ: number | null;
  /** The immediate criterion the reading was judged against; null on muted arrivals. */
  immediateThreshold: number | null;
  arrivedVerdict: GateVerdict;
}

/**
 * The segment starting at the given arrival: the stored one when the chain
 * holds it, else a fresh one the arrival must open (`opened`) in its commit.
 */
function segmentStartingAt(
  chain: LiveChain,
  startMessageId: string,
): { id: string; opened: OpenedSegment | null } {
  const storedId = chain.segmentIdByStart.get(startMessageId);
  if (storedId !== undefined) return { id: storedId, opened: null };
  const opened = {
    id: randomUUID(),
    threadId: chain.threadId,
    startMessageId,
    modelId: EMBEDDING_MODEL_ID,
  };
  return { id: opened.id, opened };
}

/** The fold values a stored fold row carries. */
function foldValuesOfRow(fold: TurnFold) {
  return {
    gravitySum: fold.gravitySum,
    anchorSum: fold.anchorSum,
    anchorCount: fold.anchorCount,
    completedTurns: fold.completedTurns,
    segmentId: fold.segmentId,
  };
}

/** The judgment-state checkpoint row for one arrival's post-judgment state. */
function judgmentStateRow(
  messageId: string,
  snapshot: JudgmentStateSnapshot,
): NewArrivalJudgmentState {
  return {
    messageId,
    modelId: EMBEDDING_MODEL_ID,
    baselineCount: snapshot.baseline.count,
    baselineMean: snapshot.baseline.mean,
    baselineM2: snapshot.baseline.m2,
    patrolCount: snapshot.patrol.count,
    patrolSum: snapshot.patrol.sum,
    patrolCumulative: snapshot.patrol.cumulative,
    patrolLowWater: snapshot.patrol.lowWater,
    patrolLowWaterMessageId: snapshot.patrol.lowWaterId,
  };
}

/** The judgment state a stored checkpoint row holds. */
function snapshotOfStateRow(row: ArrivalJudgmentState) {
  return {
    baseline: { count: row.baselineCount, mean: row.baselineMean, m2: row.baselineM2 },
    patrol: {
      count: row.patrolCount,
      sum: row.patrolSum,
      cumulative: row.patrolCumulative,
      lowWater: row.patrolLowWater,
      lowWaterId: row.patrolLowWaterMessageId,
    },
  };
}

/**
 * The newest live completed Turn before the arrival at `position`, with
 * the position of the arrival it completed; null when the chain holds
 * none. Arrivals that never got a reply are passed over.
 */
function newestTurnBefore({ chain, position }: { chain: LiveChain; position: number }) {
  for (let earlier = position - 1; earlier >= chain.before.arrivals; earlier -= 1) {
    const reply = arrivalAt({ chain, position: earlier })?.assistantReply;
    if (reply) return { position: earlier, reply };
  }
  return null;
}

/**
 * Whether the fold of the Turn completed at `from` still describes the
 * segment at `to`. Every arrival between them never got a reply, so none
 * of them folded anything. Each must have a stored verdict that did not
 * fire, because a fire opens a segment that no fold describes.
 */
function foldReaches({ chain, from, to }: { chain: LiveChain; from: number; to: number }) {
  for (let between = from + 1; between < to; between += 1) {
    const arrival = arrivalAt({ chain, position: between });
    const verdict = arrival && chain.verdicts.get(arrival.userMessage.id);
    if (!verdict || verdict.verdict === 'fire') return false;
  }
  return true;
}

/**
 * The keep-two survivors for the verdict of the arrival at `arrivalIndex`:
 * its own checkpoints, the previous arrival's judgment state, and the fold
 * of the newest completed Turn before it.
 */
function checkpointsToKeep({
  chain,
  arrivalIndex,
}: {
  chain: LiveChain;
  arrivalIndex: number;
}): KeptCheckpoints {
  const arrival = arrivalAt({ chain, position: arrivalIndex });
  const previous = arrivalAt({ chain, position: arrivalIndex - 1 });
  const previousReply = newestTurnBefore({ chain, position: arrivalIndex })?.reply;
  return {
    stateMessageIds: [previous, arrival].flatMap((row) => (row ? [row.userMessage.id] : [])),
    foldMessageIds: [previousReply, arrival?.assistantReply].flatMap((reply) =>
      reply ? [reply.id] : [],
    ),
  };
}

/**
 * Judges the arrival against the gravity point as it stands before this
 * arrival folds. The fold is left unchanged. The judgment does update the
 * segment's verdict state: its baseline and its slow patrol.
 */
function evaluateArrivalAgainstRunningState(
  state: RunningGateState,
  vector: readonly number[],
  sampleId: string,
): ArrivedJudgment {
  const gravity = state.memberSum === null ? null : unitVector(state.memberSum);
  const driftP = gravity === null ? null : cosineDistance(vector, gravity);
  const anchorDriftP =
    state.currentSegmentAnchor === null
      ? null
      : cosineDistance(vector, unitVector(state.currentSegmentAnchor));
  const muted = isColdStart(state.completedTurns, state.judging, driftP);
  let fired = false;
  let judgment: ReturnType<typeof evaluateAndRecord>['judgment'] | null = null;
  if (!muted && driftP !== null && anchorDriftP !== null) {
    ({ judgment, fired } = evaluateAndRecord({
      state: state.verdictState,
      params: state.judging,
      reading: driftP,
      anchorReading: anchorDriftP,
      sampleId,
    }));
  }
  let arrivedVerdict: GateVerdict = 'pass';
  if (muted) arrivedVerdict = 'muted';
  else if (fired) arrivedVerdict = 'fire';
  return {
    muted,
    fired,
    fireChannel: judgment?.fireChannel ?? null,
    slowDriftStartMessageId: judgment?.slowDriftStartMessageId ?? null,
    driftP,
    segmentMu: judgment?.segmentMu ?? null,
    segmentSigma: judgment?.segmentSigma ?? null,
    immediateZ: judgment?.immediateZ ?? null,
    immediateThreshold: judgment?.immediateThreshold ?? null,
    arrivedVerdict,
  };
}

/** The arrival's verdict row in the current segment; null when one is recorded already. */
function verdictRowOrNull(
  state: RunningGateState,
  chain: LiveChain,
  userMessageId: string,
  judged: ArrivedJudgment,
): NewSegmentDriftLog | null {
  if (chain.verdicts.has(userMessageId)) return null;
  return {
    // Set before any arrival is judged: every arrival opens one when none is current.
    segmentId: state.currentSegmentId as string,
    messageId: userMessageId,
    modelId: EMBEDDING_MODEL_ID,
    driftP: judged.muted ? null : judged.driftP,
    mu: judged.segmentMu,
    sigma: judged.segmentSigma,
    zScore: judged.immediateZ,
    verdict: judged.arrivedVerdict,
    fireChannel: judged.fireChannel,
    slowDriftStartMessageId: judged.slowDriftStartMessageId,
    immediateThreshold: judged.muted ? null : judged.immediateThreshold,
  };
}

/**
 * Resolves the embedding for a completed turn. Prefers the stored row
 * when it already carries a vector for this embedding model; otherwise
 * embeds the turn text and records it — spend included — folding
 * whichever vector is stored first. Returns the vector with the chain
 * that holds it.
 */
async function resolveTurnVector(input: {
  chain: LiveChain;
  text: string;
  assistantMessage: Message;
}) {
  const { chain, assistantMessage } = input;
  const stored = await storedVectorAndChainOrNull(chain, assistantMessage.id);
  if (stored !== null) return ok(stored);
  const embedded = await embedText(input.text);
  if (embedded.type === 'error') return embedded;
  const row = await recordMessageEmbedding({
    messageId: assistantMessage.id,
    embedding: embedded.data.embedding,
    modelId: EMBEDDING_MODEL_ID,
    embeddingCostUsd: await computeEmbeddingCostUsd(embedded.data.promptTokens),
    promptTokens: embedded.data.promptTokens,
  });
  return ok({ vector: row.embedding, chain: withEmbedding(chain, row) });
}

/**
 * The arrival's completed Turn: its formatted text and the reply that
 * completed it. Null while the Turn is still open.
 */
function completedTurnOf(arrival: LiveArrival) {
  if (!arrival.assistantReply) return null;
  const turn: Turn = {
    turnNumber: arrival.turnNumber,
    userMessage: arrival.userMessage,
    assistantMessage: arrival.assistantReply,
  };
  return { text: formattedTurn(turn), assistantMessage: arrival.assistantReply };
}

/**
 * The fold one Turn's vector leaves: reseeded to the vector alone when
 * the arrival fired (or nothing precedes it), accumulated onto the
 * previous fold otherwise — the same sums, in the same order, a rebuild
 * would produce.
 */
function foldValues(input: {
  prev: TurnFoldValues | null;
  vector: readonly number[];
  segmentId: string;
  /** Thread-wide Turn count after this one — kept across a fire. */
  completedTurns: number;
}) {
  // No previous fold — a fire shredded the segment, or this is the
  // Thread's first Turn — either way the sums start from this vector.
  if (input.prev === null) {
    return {
      gravitySum: [...input.vector],
      anchorSum: [...input.vector],
      anchorCount: 1,
      completedTurns: input.completedTurns,
      segmentId: input.segmentId,
    };
  }
  const anchorCount = Math.min(input.prev.anchorCount + 1, 3);
  return {
    gravitySum: accumulate([...input.prev.gravitySum], input.vector),
    anchorSum:
      input.prev.anchorCount < 3
        ? accumulate([...input.prev.anchorSum], input.vector)
        : [...input.prev.anchorSum],
    anchorCount,
    completedTurns: input.completedTurns,
    segmentId: input.segmentId,
  };
}

/**
 * Where the sums of this arrival's unfired Turn start: from its own
 * vector for the Thread's first Turn (`start`), or from the stored fold
 * of the newest live completed Turn before it (`accumulate`). `unknown`
 * when no honest starting point is at hand: that Turn's fold is missing
 * or stale, it lies before the arrivals the chain holds, or an unanswered
 * arrival after it fired.
 */
async function sumsStartOf({ chain, arrivalIndex }: { chain: LiveChain; arrivalIndex: number }) {
  const turnsBefore = completedTurnsBefore({ chain, position: arrivalIndex });
  const previous = newestTurnBefore({ chain, position: arrivalIndex });
  if (previous === null) return turnsBefore === 0 ? START_FROM_TURN : UNKNOWN_START;
  if (!foldReaches({ chain, from: previous.position, to: arrivalIndex })) return UNKNOWN_START;
  // A fold's row needs its reply's embedding, so a reply without one has no fold.
  if (!chain.embedded.has(previous.reply.id)) return UNKNOWN_START;
  const stored = await findTurnFoldOrNull({
    messageId: previous.reply.id,
    modelId: EMBEDDING_MODEL_ID,
  });
  if (stored === null || stored.completedTurns !== turnsBefore) return UNKNOWN_START;
  return { kind: 'accumulate' as const, fold: foldValuesOfRow(stored) };
}

const START_FROM_TURN = { kind: 'start' } as const;

const UNKNOWN_START = { kind: 'unknown' } as const;

/**
 * Folds the arrival's completed Turn and stores its checkpoint. The
 * fold already stored is the answer (the queue task or another pass got
 * there first — the values are the same either way); null when nothing
 * is owed (the Turn is still open) or the inputs are missing (no stored
 * verdict yet, no previous fold to accumulate onto, no segment to land
 * in) — the give-ups that leave the fold to the next judgment's inline
 * try or the rebuild.
 */
async function foldTurnOfArrival(input: {
  chain: LiveChain;
  arrivalIndex: number;
}): Promise<Result<{ fold: TurnFoldValues | null; chain: LiveChain }>> {
  const { chain } = input;
  const arrival = arrivalAt({ chain, position: input.arrivalIndex });
  if (!arrival?.assistantReply) return ok({ fold: null, chain });
  const reply = arrival.assistantReply;

  // A fold's row needs its reply's embedding, so a reply without one has no fold.
  if (chain.embedded.has(reply.id)) {
    const storedFold = await findTurnFoldOrNull({
      messageId: reply.id,
      modelId: EMBEDDING_MODEL_ID,
    });
    if (storedFold !== null) return ok({ fold: foldValuesOfRow(storedFold), chain });
  }

  const verdict = chain.verdicts.get(arrival.userMessage.id);
  if (!verdict) return ok({ fold: null, chain });
  const fired = verdict.verdict === 'fire';

  // A fire reseeds the segment it opened from this Turn alone. Any other
  // Turn accumulates onto the segment's running sums as the newest
  // earlier Turn left them.
  const sumsStart = fired ? START_FROM_TURN : await sumsStartOf(input);
  if (sumsStart.kind === 'unknown') return ok({ fold: null, chain });
  const prev = sumsStart.kind === 'accumulate' ? sumsStart.fold : null;

  // The segment this fold lands in: the one its own arrival's fire
  // opened, else the one the arrival was judged in.
  const segmentId = fired
    ? (chain.segmentIdByStart.get(arrival.userMessage.id) ?? null)
    : verdict.segmentId;
  if (segmentId === null) return ok({ fold: null, chain });

  const completion = completedTurnOf(arrival);
  if (completion === null) return ok({ fold: null, chain });
  const resolved = await resolveTurnVector({
    chain,
    text: completion.text,
    assistantMessage: reply,
  });
  if (resolved.type === 'error') return resolved;
  const { vector, chain: withVector } = resolved.data;

  const values = foldValues({
    prev,
    vector,
    segmentId,
    completedTurns: completedTurnsBefore({ chain, position: input.arrivalIndex }) + 1,
  });
  const stored = await insertTurnFoldIfAbsent({
    fold: {
      messageId: reply.id,
      modelId: EMBEDDING_MODEL_ID,
      segmentId: values.segmentId,
      gravitySum: values.gravitySum,
      anchorSum: values.anchorSum,
      anchorCount: values.anchorCount,
      completedTurns: values.completedTurns,
    },
  });
  return ok({ fold: foldValuesOfRow(stored), chain: withVector });
}

/**
 * Stores the arrival's judgment, when the chain lacks any part of it, and
 * returns the chain holding it, or why nothing was stored: another pass
 * stored it first, or an arrival it would open a segment at was abandoned.
 */
async function commitJudgment(input: {
  chain: LiveChain;
  messageId: string;
  verdict: NewSegmentDriftLog | null;
  openedSegments: OpenedSegment[];
  judgmentState: NewArrivalJudgmentState;
  keep: KeptCheckpoints;
}) {
  const { chain, messageId, verdict, openedSegments, judgmentState, keep } = input;
  if (verdict === null && openedSegments.length === 0) return { kind: 'committed' as const, chain };
  const appended = await appendArrivalVerdict({
    threadId: chain.threadId,
    openedSegments,
    verdict,
    judgmentState,
    keep,
  });
  if (appended !== 'appended') return { kind: appended } as const;
  const committed = withJudgment(chain, {
    messageId,
    verdict:
      verdict === null
        ? null
        : {
            segmentId: verdict.segmentId,
            verdict: verdict.verdict,
            fireChannel: verdict.fireChannel ?? null,
            slowDriftStartMessageId: verdict.slowDriftStartMessageId ?? null,
          },
    openedSegments,
  });
  return { kind: 'committed' as const, chain: committed };
}

/**
 * How a fill-forward pass ended: every arrival through the target judged
 * and folded, or stopped at the first arrival another pass stored first.
 * Either way it carries the chain the pass worked on.
 */
type FillEnded =
  | { kind: 'filled'; chain: LiveChain }
  | { kind: 'written-by-another-pass'; chain: LiveChain };

/**
 * Judges one arrival against the given gate state and commits it — the
 * verdict, the segments it opens, its judgment-state checkpoint, and the
 * keep-two pruning — or reports another pass got there first. A verdict
 * already recorded makes no commit: its checkpoint already exists, and
 * the judgment still runs, to advance this pass's state in memory.
 */
async function judgeAndCommit(input: {
  state: RunningGateState;
  chain: LiveChain;
  arrival: LiveArrival;
  arrivalIndex: number;
}): Promise<Result<FillEnded>> {
  const { state, arrival } = input;
  const userMessageId = arrival.userMessage.id;

  const stored = await storedVectorAndChainOrNull(input.chain, userMessageId);
  if (stored === null) {
    return err(
      'arrival_signal_missing',
      'The arriving message has no embedding: the transformer has not finished.',
    );
  }
  const { vector, chain } = stored;

  const chainOpening =
    state.currentSegmentId === null ? segmentStartingAt(chain, userMessageId) : null;
  if (chainOpening !== null) state.currentSegmentId = chainOpening.id;

  const judged = evaluateArrivalAgainstRunningState(state, vector, userMessageId);
  const verdict = verdictRowOrNull(state, chain, userMessageId, judged);

  // A fired arrival burns the segment it was judged in. Its own completed
  // turn will re-seed the next segment's gravity point.
  const fireOpening = judged.fired ? segmentStartingAt(chain, userMessageId) : null;
  if (fireOpening !== null) {
    state.memberSum = null;
    state.currentSegmentId = fireOpening.id;
  }

  const commit = await commitJudgment({
    chain,
    messageId: userMessageId,
    verdict,
    openedSegments: [chainOpening?.opened, fireOpening?.opened].filter(
      (segment): segment is OpenedSegment => segment != null,
    ),
    judgmentState: judgmentStateRow(userMessageId, snapshotOfVerdictState(state.verdictState)),
    keep: checkpointsToKeep({ chain, arrivalIndex: input.arrivalIndex }),
  });
  switch (commit.kind) {
    case 'committed':
      return ok({ kind: 'filled', chain: commit.chain });
    case 'written-by-another-pass':
      return ok({ kind: 'written-by-another-pass', chain });
    case 'opener-abandoned':
    case 'arrival-abandoned':
      return err('arrival_not_live', 'The arrival was abandoned while it was judged.');
    default: {
      const _check: never = commit;
      return _check;
    }
  }
}

/**
 * Folds a completed turn into the current segment's gravity point — the
 * walk's in-memory fold, which the walk writes as checkpoints when it
 * ends. On fire, the segment re-seeds from this turn's own vector instead
 * of accumulating. Returns the chain holding the turn's embedding.
 */
async function foldTurnIntoWalk(input: {
  state: RunningGateState & { lastFolds: FoldedTurn[] };
  chain: LiveChain;
  arrival: LiveArrival;
  reseed: boolean;
}) {
  const completion = completedTurnOf(input.arrival);
  if (completion === null) return ok(input.chain);
  const resolved = await resolveTurnVector({
    chain: input.chain,
    text: completion.text,
    assistantMessage: completion.assistantMessage,
  });
  if (resolved.type === 'error') return resolved;
  const { vector } = resolved.data;
  const { state } = input;
  const values = foldValues({
    // The fire's Turn re-seeds the segment it opens; the Thread's first
    // Turn has nothing to accumulate onto. Either way the fold's sums
    // start from this vector.
    prev:
      input.reseed || state.memberSum === null || state.currentSegmentAnchor === null
        ? null
        : {
            gravitySum: state.memberSum,
            anchorSum: state.currentSegmentAnchor,
            anchorCount: state.anchorMemberCount,
            completedTurns: state.completedTurns,
            segmentId: state.currentSegmentId as string,
          },
    vector,
    segmentId: state.currentSegmentId as string,
    completedTurns: state.completedTurns + 1,
  });
  state.memberSum = values.gravitySum;
  state.currentSegmentAnchor = values.anchorSum;
  state.anchorMemberCount = values.anchorCount;
  state.completedTurns = values.completedTurns;
  state.lastFolds.push({
    assistantMessageId: completion.assistantMessage.id,
    values,
  });
  if (state.lastFolds.length > 2) state.lastFolds.shift();
  return ok(resolved.data.chain);
}

/**
 * Processes one arrival during the rebuild walk: judges it against the
 * rebuilt gate state, commits the verdict when missing together with the
 * fresh segment a fire starts and its judgment-state checkpoint, and
 * folds its completed turn.
 */
async function processArrival(input: {
  state: RunningGateState & { lastFolds: FoldedTurn[] };
  chain: LiveChain;
  arrival: LiveArrival;
  arrivalIndex: number;
}): Promise<Result<FillEnded>> {
  const judged = await judgeAndCommit({
    state: input.state,
    chain: input.chain,
    arrival: input.arrival,
    arrivalIndex: input.arrivalIndex,
  });
  if (judged.type === 'error') return judged;
  if (judged.data.kind === 'written-by-another-pass') return judged;
  const folded = await foldTurnIntoWalk({
    state: input.state,
    chain: judged.data.chain,
    arrival: input.arrival,
    // The committed chain holds the verdict whether this pass judged it
    // or replayed it from the store; a fire's Turn reseeds either way.
    reseed: wasFired({ chain: judged.data.chain, arrival: input.arrival }),
  });
  if (folded.type === 'error') return folded;
  return ok({ kind: 'filled', chain: folded.data });
}

/** Whether the arrival's stored-or-just-judged verdict fired. */
function wasFired({ chain, arrival }: { chain: LiveChain; arrival: LiveArrival }) {
  return chain.verdicts.get(arrival.userMessage.id)?.verdict === 'fire';
}

/**
 * Rebuilds the gate's state from the live chain and processes arrivals up
 * to (inclusive of) the target index. Stored rows are replayed; anything
 * missing is computed and persisted on the spot. The chain holds only the
 * live conversation: abandoned arrivals keep their stored segments and
 * logs (usage keeps tracking them) but the walk never touches them. Each
 * judged arrival's commit writes its checkpoint and prunes to keep-two;
 * the walk ends by storing the last two folded Turns' folds. Stops early,
 * without error, at the first arrival another pass wrote first.
 */
async function fillForwardToArrival(
  chain: LiveChain,
  targetIndex: number,
): Promise<Result<FillEnded>> {
  const judging = JUDGING_DEFAULTS;
  const state: RunningGateState & { lastFolds: FoldedTurn[] } = {
    judging,
    verdictState: createVerdictState(judging),
    memberSum: null,
    currentSegmentAnchor: null,
    anchorMemberCount: 0,
    completedTurns: 0,
    currentSegmentId: null,
    lastFolds: [],
  };

  // The walk measures every arrival and folds every Turn, so it reads every vector at once.
  let current = await withEveryVector(chain);
  for (let i = 0; i <= targetIndex; i += 1) {
    const arrival = arrivalAt({ chain: current, position: i });
    if (!arrival) continue;
    const processed = await processArrival({ state, chain: current, arrival, arrivalIndex: i });
    if (processed.type === 'error') return processed;
    if (processed.data.kind === 'written-by-another-pass') return processed;
    current = processed.data.chain;
  }
  for (const folded of state.lastFolds) {
    await insertTurnFoldIfAbsent({
      fold: {
        messageId: folded.assistantMessageId,
        modelId: EMBEDDING_MODEL_ID,
        ...folded.values,
      },
    });
  }
  return ok({ kind: 'filled', chain: current });
}

/**
 * Judges the target arrival from the stored checkpoints: the previous
 * arrival's judgment state (the baseline and the patrol it left) and the
 * fold of the newest completed Turn before it (the segment geometry as
 * the conversation left it). The fold task lagging is not a rebuild: that
 * Turn folds inline first. Anything else missing or stale — an earlier
 * arrival without a verdict, no checkpoint rows, a fold whose
 * completed-Turn count no longer matches the live chain (a row that
 * appeared or left beneath it) — says the checkpoints cannot speak for the
 * chain, and the rebuild is the honest answer.
 */
async function judgeFromCheckpoints({
  chain,
  targetIndex,
}: {
  chain: LiveChain;
  targetIndex: number;
}): Promise<Result<FillEnded | { kind: 'rebuild' }>> {
  const target = arrivalAt({ chain, position: targetIndex });
  if (!target) return err('thread_not_found');
  const previous = chain.arrivals.filter((arrival) => arrival.turnNumber <= targetIndex);
  if (
    chain.before.unjudged ||
    previous.some((arrival) => !chain.verdicts.has(arrival.userMessage.id))
  ) {
    return ok({ kind: 'rebuild' });
  }

  const judging = JUDGING_DEFAULTS;

  // The Thread's first arrival judges from scratch: no checkpoint exists
  // to read, and none is needed.
  if (targetIndex === 0) {
    const state: RunningGateState = {
      judging,
      verdictState: createVerdictState(judging),
      memberSum: null,
      currentSegmentAnchor: null,
      anchorMemberCount: 0,
      completedTurns: 0,
      currentSegmentId: null,
    };
    return judgeAndCommit({ state, chain, arrival: target, arrivalIndex: targetIndex });
  }

  const prev = arrivalAt({ chain, position: targetIndex - 1 });
  const prevTurn = newestTurnBefore({ chain, position: targetIndex });
  if (!prev || prevTurn === null) return ok({ kind: 'rebuild' });
  if (!foldReaches({ chain, from: prevTurn.position, to: targetIndex })) {
    return ok({ kind: 'rebuild' });
  }
  const inlineFold = await foldTurnOfArrival({ chain, arrivalIndex: prevTurn.position });
  if (inlineFold.type === 'error') return inlineFold;
  const prevFold = inlineFold.data.fold;
  if (prevFold === null) return ok({ kind: 'rebuild' });
  // The fold's completed-Turn count must equal the live Turns before the
  // target: a mismatch means a row under the fold left or joined the chain.
  if (prevFold.completedTurns !== completedTurnsBefore({ chain, position: targetIndex })) {
    return ok({ kind: 'rebuild' });
  }

  const prevState = await findArrivalJudgmentStateOrNull({
    messageId: prev.userMessage.id,
    modelId: EMBEDDING_MODEL_ID,
  });
  if (prevState === null) return ok({ kind: 'rebuild' });

  const state: RunningGateState = {
    judging,
    verdictState: createVerdictState(judging, snapshotOfStateRow(prevState)),
    memberSum: prevFold.gravitySum,
    currentSegmentAnchor: prevFold.anchorSum,
    anchorMemberCount: prevFold.anchorCount,
    completedTurns: prevFold.completedTurns,
    currentSegmentId: prevFold.segmentId,
  };
  return judgeAndCommit({
    state,
    chain: inlineFold.data.chain,
    arrival: target,
    arrivalIndex: targetIndex,
  });
}

/**
 * Brings the target arrival to its finished state: its verdict stored,
 * and its Turn folded once the reply has completed. Two passes can
 * judge the same arrival at the same time, and the pass that stores
 * first wins — the loser rereads what is now stored and tries again.
 * The reread carries the rows the winner stored, so the next attempt
 * replays that arrival instead of racing it again; every attempt gets
 * at least one arrival further, so the fill ends within one attempt
 * per arrival, plus the one that finishes. The target's own Turn folds
 * here too, when its reply has completed — the queue task may not
 * have run yet, and the next arrival's judgment would fold it inline
 * anyway. A rebuild on any attempt switches the pass to the whole live
 * chain, so the target is found again by its Message on each attempt.
 */
async function fillPastOtherPasses({
  chain,
  messageId,
  attemptsLeft,
}: {
  chain: LiveChain;
  /** The target arrival's user Message. */
  messageId: string;
  attemptsLeft: number;
}): Promise<Result<LiveChain>> {
  const arrivalIndex = positionOf({ chain, messageId });
  const target = arrivalAt({ chain, position: arrivalIndex });
  if (!target) return err('thread_not_found');
  if (isArrivalFinished(chain, target)) return ok(chain);
  if (attemptsLeft === 0) {
    return err(
      'thread_analysis_failed',
      'Other passes kept storing the chain ahead of this one; the arrival is left unjudged.',
    );
  }

  let filled: Result<FillEnded>;
  if (chain.verdicts.has(target.userMessage.id)) {
    // Only the fold is owed; a judgment would re-decide nothing.
    filled = ok({ kind: 'filled', chain });
  } else {
    const judged = await judgeFromCheckpoints({ chain, targetIndex: arrivalIndex });
    if (judged.type === 'error') return judged;
    if (judged.data.kind === 'rebuild') {
      filled = await rebuildThroughArrival({ chain, messageId });
    } else {
      filled = ok(judged.data);
    }
  }
  if (filled.type === 'error') return filled;
  const reached = filled.data.chain;
  if (filled.data.kind === 'written-by-another-pass') {
    const reread: LiveChain = { ...reached, ...(await readStoredJudgments(reached)) };
    return fillPastOtherPasses({ chain: reread, messageId, attemptsLeft: attemptsLeft - 1 });
  }

  const folded = await foldTurnOfArrival({
    chain: reached,
    arrivalIndex: positionOf({ chain: reached, messageId }),
  });
  if (folded.type === 'error') return folded;
  return ok(folded.data.chain);
}

/**
 * Rebuilds the gate's state from the first live arrival through the
 * target. A chain that holds only the newest arrivals is read again in
 * whole first. That read comes later than the newest rows, so the target
 * is found again by its Message, and an arrival abandoned meanwhile is no
 * longer live.
 */
async function rebuildThroughArrival({
  chain,
  messageId,
}: {
  chain: LiveChain;
  /** The target arrival's user Message. */
  messageId: string;
}) {
  const whole = chain.before.arrivals === 0 ? chain : await readLiveChain(chain.threadId);
  const targetIndex = positionOf({ chain: whole, messageId });
  if (targetIndex < 0) {
    return err('arrival_not_live', 'The arrival was abandoned while it was judged.');
  }
  return fillForwardToArrival(whole, targetIndex);
}

export const verdictAndFoldStep: MessageStep = {
  name: 'verdict-and-fold',
  async run({ chain, arrivalIndex }) {
    const target = arrivalAt({ chain, position: arrivalIndex });
    if (!target) return err('thread_not_found');
    return fillPastOtherPasses({
      chain,
      messageId: target.userMessage.id,
      // One attempt per live arrival through the target, plus the one that finishes.
      attemptsLeft: chain.before.arrivals + chain.arrivals.length + 1,
    });
  },
};

/**
 * Folds the Turn whose reply completed, the way the queue asks for it.
 * Give-ups write nothing: the gate switched off, the reply no longer
 * live, its Turn not the newest complete one (the keep-two rule has
 * moved past it), or the inputs it would fold from are missing — the
 * next arrival's judgment folds inline whatever this left behind. Only
 * a provider failure fails the call; the fold is worth retrying, and the
 * embedding it pays for is worth recording.
 */
export async function foldTurnOfReply({
  threadId,
  replyMessageId,
  mode,
}: {
  threadId: string;
  /** The Turn's assistant Message. */
  replyMessageId: string;
  mode: ThreadAnalysisMode;
}) {
  if (mode === 'off') return ok(null);
  // A reply missing from the newest live rows is no longer live, or a later Turn completed.
  const chain = await readLiveTail({ threadId, arrivalId: null });
  const arrival = chain.arrivals.find((row) => row.assistantReply?.id === replyMessageId);
  if (!arrival) return ok(null);
  if (chain.arrivals.some((row) => row.turnNumber > arrival.turnNumber && row.assistantReply)) {
    return ok(null);
  }
  const folded = await foldTurnOfArrival({ chain, arrivalIndex: arrival.turnNumber - 1 });
  if (folded.type === 'error') return folded;
  return ok(null);
}

/** Adds a vector to the segment's elementwise running sum. */
function accumulate(sum: number[], vector: readonly number[]) {
  for (let i = 0; i < sum.length; i += 1) {
    sum[i] = (sum[i] ?? 0) + (vector[i] ?? 0);
  }
  return sum;
}

function unitVector(vector: number[]) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) throw new Error('gravity vector collapsed to zero');
  return vector.map((value) => value / norm);
}

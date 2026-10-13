import { randomUUID } from 'node:crypto';
import { env } from '@config/env';
import type {
  ArrivalJudgmentState,
  Message,
  NewArrivalJudgmentState,
  NewSegmentDriftLog,
  TurnFold,
} from '@db/types';
import { findArrivalJudgmentStateOrNull } from '@queries/arrivalJudgmentStates/findArrivalJudgmentStateOrNull';
import { recordMessageEmbedding } from '@queries/messageEmbeddings/recordMessageEmbedding';
import {
  type KeptCheckpoints,
  type OpenedSegment,
  appendArrivalVerdict,
} from '@queries/segmentDriftLogs/appendArrivalVerdict';
import { findTurnFoldOrNull } from '@queries/turnFolds/findTurnFoldOrNull';
import { insertTurnFoldIfAbsent } from '@queries/turnFolds/insertTurnFoldIfAbsent';
import { type Result, err, ok } from '../../../types/result';
import { EMBEDDING_MODEL_ID, computeEmbeddingCostUsd, embedText } from '../../aiService';
import { cosineDistance } from '../drift';
import { type Turn, formattedTurn } from '../turns';
import { DEFAULT_ANALYZE_OPTIONS, type GateVerdict } from '../types';
import {
  type JudgingParams,
  type JudgmentStateSnapshot,
  createVerdictState,
  evaluateAndRecord,
  isColdStart,
  snapshotOfVerdictState,
} from '../verdict';
import {
  type LiveChain,
  isArrivalFinished,
  readLiveChain,
  readStoredJudgments,
  storedVectorOrNull,
  withEmbedding,
  withJudgment,
} from './liveChain';
import type { LiveTurnRow } from './liveTurns';
import type { MessageStep } from './messageStep';

/**
 * Verdict-and-fold step: judges the arrival against the current segment's
 * Gravity point, starts a fresh segment on a fire, and folds completed
 * turns into that Gravity point.
 *
 * Judging is checkpointed. Every arrival's verdict commit stores the
 * judgment state its judgment leaves behind — the segment baseline and
 * the slow patrol — and every folded Turn stores its fold: the segment's
 * summed geometry, its segment, and the count of Turns folded. The next
 * judgment starts from the previous arrival's two rows instead of
 * rebuilding the whole chain, so a judgment costs the same on the
 * hundredth arrival of a Thread as on the first. The keep-two rule prunes
 * every other checkpoint of the Thread and model in the verdict's own
 * transaction; abandoned arrivals keep theirs.
 *
 * Checkpoints that are missing or stale — a Thread from before the
 * checkpoints existed, a fold task that never ran, an arrival abandoned
 * beneath a stored fold's Turn count — fall back to the rebuild: the
 * walk replays stored rows from the first arrival, judges what is
 * missing, and writes the checkpoints keep-two keeps on its way out, so
 * a rebuild heals the chain it walked. A verdict another pass wrote first
 * still wins: the commit is one transaction, and the loser rereads what
 * is stored and fills forward again.
 *
 * The queue folds each Turn when its reply completes; a judgment that
 * finds that task has not run folds the Turn inline — the same routine,
 * the same values. This step cannot fail open: an arrival whose
 * embedding is missing means the transformer has not finished, and the
 * exchange surfaces the failure so the retry resumes the pass.
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
  fireChannel: 'immediate' | 'slow' | null;
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
function valuesOf(fold: TurnFold): TurnFoldValues {
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
function snapshotOfStateRow(row: ArrivalJudgmentState): JudgmentStateSnapshot {
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

/** The keep-two survivors for the verdict of the arrival at `arrivalIndex`. */
function keepFor(chain: LiveChain, arrivalIndex: number): KeptCheckpoints {
  const stateMessageIds: string[] = [];
  const foldMessageIds: string[] = [];
  for (const index of [arrivalIndex - 1, arrivalIndex]) {
    const arrival = chain.arrivals[index];
    if (!arrival) continue;
    stateMessageIds.push(arrival.userMessage.id);
    if (arrival.assistantReply) foldMessageIds.push(arrival.assistantReply.id);
  }
  return { stateMessageIds, foldMessageIds };
}

/**
 * Judge the arrival against the gravity point as it stands BEFORE this
 * arrival folds. Doesn't mutate the fold or the gate's geometry — folding
 * happens afterwards.
 */
function evaluateArrivalAgainstRunningState(
  state: RunningGateState,
  vector: number[],
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
    ({ judgment, fired } = evaluateAndRecord(
      state.verdictState,
      state.judging,
      driftP,
      anchorDriftP,
      sampleId,
    ));
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
}): Promise<Result<{ vector: number[]; chain: LiveChain }>> {
  const { chain, assistantMessage } = input;
  const storedVector = storedVectorOrNull(chain.embeddings.get(assistantMessage.id));
  if (storedVector !== null) return ok({ vector: storedVector, chain });
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

/** Formats a completed turn. Returns null while the turn is still open. */
function completeTurnOrNull(row: LiveTurnRow): { text: string; assistantMessage: Message } | null {
  if (!row.assistantReply) return null;
  const turn: Turn = {
    turnNumber: row.turnNumber,
    userMessage: row.userMessage,
    assistantMessage: row.assistantReply,
  };
  return { text: formattedTurn(turn), assistantMessage: row.assistantReply };
}

/**
 * The fold one Turn's vector leaves: reseeded to the vector alone when
 * the arrival fired (or nothing precedes it), accumulated onto the
 * previous fold otherwise — the same sums, in the same order, a rebuild
 * would produce.
 */
function foldValues(input: {
  prev: TurnFoldValues | null;
  vector: number[];
  segmentId: string;
  /** Thread-wide Turn count after this one — kept across a fire. */
  completedTurns: number;
}): TurnFoldValues {
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
  const arrival = chain.arrivals[input.arrivalIndex];
  if (!arrival || !arrival.assistantReply) return ok({ fold: null, chain });
  const reply = arrival.assistantReply;

  const storedFold = await findTurnFoldOrNull({
    messageId: reply.id,
    modelId: EMBEDDING_MODEL_ID,
  });
  if (storedFold !== null) return ok({ fold: valuesOf(storedFold), chain });

  const verdict = chain.verdicts.get(arrival.userMessage.id);
  if (!verdict) return ok({ fold: null, chain });
  const fired = verdict.verdict === 'fire';

  // The accumulate-from point: the previous Turn's fold — the segment's
  // running sums as this Thread last left them.
  let prev: TurnFoldValues | null = null;
  const prevArrival = chain.arrivals[input.arrivalIndex - 1];
  if (prevArrival?.assistantReply) {
    const prevFold = await findTurnFoldOrNull({
      messageId: prevArrival.assistantReply.id,
      modelId: EMBEDDING_MODEL_ID,
    });
    if (prevFold !== null) prev = valuesOf(prevFold);
  }
  // A fire reseeds; so does the Thread's first Turn. Anything else with
  // no previous fold cannot be accumulated honestly.
  if (prev === null && !fired && input.arrivalIndex > 0) return ok({ fold: null, chain });

  // The segment this fold lands in: the one its own arrival's fire
  // opened, else the one the conversation already sits in — the Thread's
  // first Turn reads its arrival's own judged-in segment (no previous
  // fold exists to carry it).
  const segmentId = chain.segmentIdByStart.get(arrival.userMessage.id) ?? prev?.segmentId ?? null;
  if (segmentId === null) return ok({ fold: null, chain });

  const completion = completeTurnOrNull(arrival);
  if (completion === null) return ok({ fold: null, chain });
  const resolved = await resolveTurnVector({
    chain,
    text: completion.text,
    assistantMessage: reply,
  });
  if (resolved.type === 'error') return resolved;
  const { vector, chain: withVector } = resolved.data;

  const values = foldValues({
    // A fire shredded the segment this Turn lands in: its fold re-seeds
    // the sums from its own vector instead of accumulating onto the
    // burned one's.
    prev: fired ? null : prev,
    vector,
    segmentId,
    completedTurns: (prev?.completedTurns ?? 0) + 1,
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
  return ok({ fold: valuesOf(stored), chain: withVector });
}

/**
 * Stores the arrival's judgment, when the chain lacks any part of it, and
 * returns the chain holding it; null when another pass stored it first.
 */
async function commitJudgment(input: {
  chain: LiveChain;
  messageId: string;
  verdict: NewSegmentDriftLog | null;
  openedSegments: OpenedSegment[];
  judgmentState: NewArrivalJudgmentState;
  keep: KeptCheckpoints;
}): Promise<LiveChain | null> {
  const { chain, messageId, verdict, openedSegments, judgmentState, keep } = input;
  if (verdict === null && openedSegments.length === 0) return chain;
  const appended = await appendArrivalVerdict({
    threadId: chain.threadId,
    openedSegments,
    verdict,
    judgmentState,
    keep,
  });
  if (!appended) return null;
  return withJudgment(chain, {
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
}

/**
 * How a fill-forward pass ended: every arrival through the target judged
 * and folded, with the chain holding all of it, or stopped at the first
 * arrival another pass stored first.
 */
type FillEnded = { kind: 'filled'; chain: LiveChain } | { kind: 'written-by-another-pass' };

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
  row: LiveTurnRow;
  arrivalIndex: number;
}): Promise<Result<FillEnded>> {
  const { state, chain, row } = input;
  const userMessageId = row.userMessage.id;

  const chainOpening =
    state.currentSegmentId === null ? segmentStartingAt(chain, userMessageId) : null;
  if (chainOpening !== null) state.currentSegmentId = chainOpening.id;

  const vector = storedVectorOrNull(chain.embeddings.get(userMessageId));
  if (vector === null) {
    return err(
      'arrival_signal_missing',
      'The arriving message has no embedding: the transformer has not finished.',
    );
  }

  const judged = evaluateArrivalAgainstRunningState(state, vector, userMessageId);
  const verdict = verdictRowOrNull(state, chain, userMessageId, judged);

  // A fired arrival burns the segment it was judged in. Its own completed
  // turn will re-seed the next segment's gravity point.
  const fireOpening = judged.fired ? segmentStartingAt(chain, userMessageId) : null;
  if (fireOpening !== null) {
    state.memberSum = null;
    state.currentSegmentId = fireOpening.id;
  }

  const committed = await commitJudgment({
    chain,
    messageId: userMessageId,
    verdict,
    openedSegments: [chainOpening?.opened, fireOpening?.opened].filter(
      (segment): segment is OpenedSegment => segment != null,
    ),
    judgmentState: judgmentStateRow(userMessageId, snapshotOfVerdictState(state.verdictState)),
    keep: keepFor(chain, input.arrivalIndex),
  });
  if (committed === null) return ok({ kind: 'written-by-another-pass' });
  return ok({ kind: 'filled', chain: committed });
}

/**
 * Folds a completed turn into the current segment's gravity point — the
 * walk's in-memory fold, which the walk writes as checkpoints when it
 * ends. On fire, the segment re-seeds from this turn's own vector instead
 * of accumulating. Returns the chain holding the turn's embedding.
 */
async function completeTurn(input: {
  state: RunningGateState & { lastFolds: FoldedTurn[] };
  chain: LiveChain;
  row: LiveTurnRow;
  reseed: boolean;
}): Promise<Result<LiveChain>> {
  const completion = completeTurnOrNull(input.row);
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
  row: LiveTurnRow;
  arrivalIndex: number;
}): Promise<Result<FillEnded>> {
  const judged = await judgeAndCommit({
    state: input.state,
    chain: input.chain,
    row: input.row,
    arrivalIndex: input.arrivalIndex,
  });
  if (judged.type === 'error') return judged;
  if (judged.data.kind === 'written-by-another-pass') return judged;
  const folded = await completeTurn({
    state: input.state,
    chain: judged.data.chain,
    row: input.row,
    // The committed chain holds the verdict whether this pass judged it
    // or replayed it from the store; a fire's Turn reseeds either way.
    reseed: wasFired(judged.data.chain, input.row),
  });
  if (folded.type === 'error') return folded;
  return ok({ kind: 'filled', chain: folded.data });
}

/** Whether the arrival's stored-or-just-judged verdict fired. */
function wasFired(chain: LiveChain, row: LiveTurnRow): boolean {
  return chain.verdicts.get(row.userMessage.id)?.verdict === 'fire';
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
  const judging: JudgingParams = { ...DEFAULT_ANALYZE_OPTIONS };
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

  let current = chain;
  for (let i = 0; i <= targetIndex; i += 1) {
    const row = current.arrivals[i];
    if (!row) continue;
    const processed = await processArrival({ state, chain: current, row, arrivalIndex: i });
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
 * previous Turn's fold (the segment geometry as the conversation left
 * it). The fold task lagging is not a rebuild: the previous Turn folds
 * inline first. Anything else missing or stale — no checkpoint rows, a
 * fold whose completed-Turn count no longer matches the live chain (an
 * arrival abandoned beneath it) — says the checkpoints cannot speak for
 * the chain, and the rebuild is the honest answer.
 */
async function judgeFromCheckpoints(
  chain: LiveChain,
  targetIndex: number,
): Promise<Result<FillEnded | { kind: 'rebuild' }>> {
  const target = chain.arrivals[targetIndex];
  if (!target) return err('thread_not_found');
  const previous = chain.arrivals.slice(0, targetIndex);
  if (previous.some((arrival) => !chain.verdicts.has(arrival.userMessage.id))) {
    return ok({ kind: 'rebuild' });
  }

  const judging: JudgingParams = { ...DEFAULT_ANALYZE_OPTIONS };
  const prev = previous[previous.length - 1] ?? null;

  // The Thread's first arrival judges from scratch: no checkpoint exists
  // to read, and none is needed.
  if (prev === null) {
    const state: RunningGateState = {
      judging,
      verdictState: createVerdictState(judging),
      memberSum: null,
      currentSegmentAnchor: null,
      anchorMemberCount: 0,
      completedTurns: 0,
      currentSegmentId: null,
    };
    return judgeAndCommit({ state, chain, row: target, arrivalIndex: targetIndex });
  }

  if (!prev.assistantReply) return ok({ kind: 'rebuild' });
  const inlineFold = await foldTurnOfArrival({ chain, arrivalIndex: targetIndex - 1 });
  if (inlineFold.type === 'error') return inlineFold;
  const prevFold = inlineFold.data.fold;
  if (prevFold === null) return ok({ kind: 'rebuild' });
  // The fold's completed-Turn count must equal the live Turns before the
  // target: a mismatch means something under the fold left the chain.
  if (prevFold.completedTurns !== targetIndex) return ok({ kind: 'rebuild' });

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
    row: target,
    arrivalIndex: targetIndex,
  });
}

/**
 * Fills forward until the target arrival is finished. Each lost race
 * reveals rows another pass stored and this pass had not read; with them
 * reread for the same arrivals, the next fill gets past them. So the fill
 * ends within one attempt per arrival, plus the one that finishes. The
 * target's own Turn folds here when it completed — the queue task may
 * not have run, and the next arrival's judgment would only inline it
 * anyway.
 */
async function fillPastOtherPasses(
  chain: LiveChain,
  arrivalIndex: number,
  attemptsLeft: number,
): Promise<Result<LiveChain>> {
  const target = chain.arrivals[arrivalIndex];
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
    const judged = await judgeFromCheckpoints(chain, arrivalIndex);
    if (judged.type === 'error') return judged;
    if (judged.data.kind === 'rebuild') {
      filled = await fillForwardToArrival(chain, arrivalIndex);
    } else {
      filled = ok(judged.data);
    }
  }
  if (filled.type === 'error') return filled;
  if (filled.data.kind === 'written-by-another-pass') {
    const reread: LiveChain = { ...chain, ...(await readStoredJudgments(chain)) };
    return fillPastOtherPasses(reread, arrivalIndex, attemptsLeft - 1);
  }

  const folded = await foldTurnOfArrival({ chain: filled.data.chain, arrivalIndex });
  if (folded.type === 'error') return folded;
  return ok(folded.data.chain);
}

export const verdictAndFoldStep: MessageStep = {
  name: 'verdict-and-fold',
  run: ({ chain, arrivalIndex }) =>
    fillPastOtherPasses(chain, arrivalIndex, chain.arrivals.length + 1),
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
export async function foldTurnOfReply(input: {
  threadId: string;
  /** The Turn's assistant Message. */
  replyMessageId: string;
}): Promise<Result<null>> {
  if (env.THREAD_ANALYSIS_MODE === 'off') return ok(null);
  const { threadId, replyMessageId } = input;
  const chain = await readLiveChain(threadId);
  const arrivalIndex = chain.arrivals.findIndex(
    (arrival) => arrival.assistantReply?.id === replyMessageId,
  );
  if (arrivalIndex < 0) return ok(null);
  if (chain.arrivals.slice(arrivalIndex + 1).some((arrival) => arrival.assistantReply)) {
    return ok(null);
  }
  const folded = await foldTurnOfArrival({ chain, arrivalIndex });
  if (folded.type === 'error') return folded;
  return ok(null);
}

/** Adds a vector to the segment's elementwise running sum. */
function accumulate(sum: number[], vector: number[]): number[] {
  for (let i = 0; i < sum.length; i += 1) {
    sum[i] = (sum[i] ?? 0) + (vector[i] ?? 0);
  }
  return sum;
}

function unitVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) throw new Error('gravity vector collapsed to zero');
  return vector.map((value) => value / norm);
}

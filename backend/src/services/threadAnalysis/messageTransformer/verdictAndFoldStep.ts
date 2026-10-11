import { randomUUID } from 'node:crypto';
import type { Message, MessageEmbedding, NewSegmentDriftLog } from '@db/types';
import { listMessageEmbeddingsByMessageIds } from '@queries/messageEmbeddings/listMessageEmbeddingsByMessageIds';
import { recordTurnEmbedding } from '@queries/messageEmbeddings/recordTurnEmbedding';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import {
  type OpenedSegment,
  appendArrivalVerdict,
} from '@queries/segmentDriftLogs/appendArrivalVerdict';
import { findSegmentDriftLogByMessageId } from '@queries/segmentDriftLogs/findSegmentDriftLogByMessageId';
import { listSegmentDriftLogsByThread } from '@queries/segmentDriftLogs/listSegmentDriftLogsByThread';
import { listThreadSegmentsByThread } from '@queries/threadSegments/listThreadSegmentsByThread';
import { type Result, err, ok } from '../../../types/result';
import { EMBEDDING_MODEL_ID, embedText } from '../../aiService';
import { cosineDistance } from '../drift';
import { type Turn, formattedTurn } from '../turns';
import { DEFAULT_ANALYZE_OPTIONS, type GateVerdict } from '../types';
import { type JudgingParams, createVerdictState, evaluateAndRecord, isColdStart } from '../verdict';
import { type LiveTurnRow, buildLiveTurns } from './liveTurns';
import type { MessageStep } from './messageStep';

/**
 * Verdict-and-fold step: judges the arrival against the current segment's
 * gravity point, starts a fresh segment on a fire, and folds completed
 * turns into that gravity point.
 *
 * Every run rebuilds the ledger it needs from stored rows — segments,
 * verdict log, embeddings — and fills forward through the target arrival:
 * already-recorded rows are replayed (never re-embedded, never re-judged),
 * anything missing is computed and persisted. The step short-circuits when
 * the target arrival already has its verdict row and its turn is folded.
 *
 * An arrival's verdict and the segments it opens commit together, and only
 * if no other pass wrote them first. A pass that finds it lost that race
 * stops there: the arrival is judged, and the caller reads what the winner
 * stored.
 *
 * This step cannot fail open: an arrival whose embedding is missing means
 * the transformer has not finished, and the exchange surfaces the
 * failure so the retry resumes the fill-forward pass.
 */

/** Mutable state carried across arrivals during one fill-forward pass. */
interface LiveLedgerState {
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
  /** Stored segment ids by the arrival that starts them. */
  storedSegmentIdByStart: Map<string, string>;
  /** Message ids with a recorded verdict already. */
  loggedMessageIds: Set<string>;
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
  arrivedVerdict: GateVerdict;
}

/**
 * Moves the ledger onto the segment starting at the given arrival: the
 * stored one when the chain holds it, else a fresh one the arrival opens,
 * added to `opened` for the arrival's commit.
 */
function openSegment(
  state: LiveLedgerState,
  threadId: string,
  startMessageId: string,
  opened: OpenedSegment[],
): void {
  const storedId = state.storedSegmentIdByStart.get(startMessageId);
  if (storedId !== undefined) {
    state.currentSegmentId = storedId;
    return;
  }
  const segment = { id: randomUUID(), threadId, startMessageId, modelId: EMBEDDING_MODEL_ID };
  opened.push(segment);
  state.currentSegmentId = segment.id;
}

/**
 * Judge the arrival against the gravity point as it stands BEFORE this
 * arrival folds. Doesn't mutate the fold or the ledger — folding happens
 * afterwards in completeTurn.
 */
function evaluateArrivalAgainstLedger(
  state: LiveLedgerState,
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
    arrivedVerdict,
  };
}

/** The arrival's verdict row in the current segment; null when one is recorded already. */
function verdictRowOrNull(
  state: LiveLedgerState,
  userMessageId: string,
  judged: ArrivedJudgment,
): NewSegmentDriftLog | null {
  if (state.loggedMessageIds.has(userMessageId)) return null;
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
  };
}

/**
 * Resolves the embedding for a completed turn. Prefers the stored row when
 * it already carries a vector for this embedding model; otherwise embeds
 * the turn text and records it, folding whichever vector is stored first.
 */
async function resolveTurnVector(input: {
  text: string;
  assistantMessage: Message;
  stored: MessageEmbedding | undefined;
}): Promise<Result<number[]>> {
  const stored = input.stored;
  if (stored && stored.embedding !== null && stored.modelId === EMBEDDING_MODEL_ID) {
    return ok(stored.embedding);
  }
  const embedded = await embedText(input.text);
  if (embedded.type === 'error') return embedded;
  const row = await recordTurnEmbedding({
    messageId: input.assistantMessage.id,
    embedding: embedded.data.embedding,
    modelId: EMBEDDING_MODEL_ID,
  });
  if (row.embedding === null) {
    return err('embed_failed', 'The turn embedding wrote without a vector.');
  }
  return ok(row.embedding);
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
 * Folds a completed turn into the current segment's gravity point. On fire,
 * the segment re-seeds from this turn's own vector instead of accumulating.
 */
async function completeTurn(input: {
  state: LiveLedgerState;
  row: LiveTurnRow;
  assistantStored: MessageEmbedding | undefined;
  reseed: boolean;
}): Promise<Result<undefined>> {
  const completion = completeTurnOrNull(input.row);
  if (completion === null) return ok(undefined);
  const folded = await resolveTurnVector({
    text: completion.text,
    assistantMessage: completion.assistantMessage,
    stored: input.assistantStored,
  });
  if (folded.type === 'error') return folded;
  const { state } = input;
  if (input.reseed || state.memberSum === null) {
    state.memberSum = [...folded.data];
    state.currentSegmentAnchor = [...folded.data];
    state.anchorMemberCount = 1;
  } else {
    state.memberSum = accumulate(state.memberSum, folded.data);
    if (state.anchorMemberCount < 3 && state.currentSegmentAnchor !== null) {
      state.currentSegmentAnchor = accumulate(state.currentSegmentAnchor, folded.data);
      state.anchorMemberCount += 1;
    }
  }
  state.completedTurns += 1;
  return ok(undefined);
}

/** True when the arrival's completed turn (if any) already has a stored embedding. */
async function foldComplete(row: LiveTurnRow): Promise<boolean> {
  if (!row.assistantReply) return true;
  const stored = await listMessageEmbeddingsByMessageIds({
    messageIds: [row.assistantReply.id],
  });
  const turnRow = stored[0];
  return (
    turnRow !== undefined && turnRow.embedding !== null && turnRow.modelId === EMBEDDING_MODEL_ID
  );
}

/**
 * How one arrival's processing ended: judged and folded by this pass, or
 * left to the pass that stored its judgment first.
 */
type ArrivalProcessed = 'judged' | 'written-by-another-pass';

/**
 * Processes one arrival during the fill-forward pass: secures its segment,
 * judges it against the live gravity point, commits the verdict when
 * missing together with the fresh segment a fire starts, and folds its
 * completed turn.
 */
async function processArrival(input: {
  state: LiveLedgerState;
  threadId: string;
  row: LiveTurnRow;
  storedByMessageId: Map<string, MessageEmbedding>;
}): Promise<Result<ArrivalProcessed>> {
  const { state, threadId, row, storedByMessageId } = input;
  const userMessageId = row.userMessage.id;

  const opened: OpenedSegment[] = [];
  if (state.currentSegmentId === null) openSegment(state, threadId, userMessageId, opened);

  const stored = storedByMessageId.get(userMessageId);
  if (!stored || stored.embedding === null || stored.modelId !== EMBEDDING_MODEL_ID) {
    return err(
      'arrival_signal_missing',
      'The arriving message has no embedding: the transformer has not finished.',
    );
  }

  const judged = evaluateArrivalAgainstLedger(state, stored.embedding, userMessageId);
  const verdict = verdictRowOrNull(state, userMessageId, judged);

  if (judged.fired) {
    // A fired arrival burns the segment it was judged in. Its own
    // completed turn will re-seed the next segment's gravity point.
    state.memberSum = null;
    openSegment(state, threadId, userMessageId, opened);
  }

  if (verdict !== null || opened.length > 0) {
    const appended = await appendArrivalVerdict({ openedSegments: opened, verdict });
    if (!appended) return ok('written-by-another-pass');
    state.loggedMessageIds.add(userMessageId);
  }

  const folded = await completeTurn({
    state,
    row,
    assistantStored: row.assistantReply ? storedByMessageId.get(row.assistantReply.id) : undefined,
    reseed: judged.fired,
  });
  if (folded.type === 'error') return folded;
  return ok('judged');
}

/**
 * Rebuilds the ledger from stored rows and processes arrivals up to
 * (inclusive of) the target index. Stored rows are replayed; anything
 * missing is computed and persisted on the spot. Abandoned arrivals are
 * filtered from the ledger: their segments and logs stay stored (usage
 * keeps tracking them) but the live chain follows only the live conversation.
 * Stops early, without error, at the first arrival another pass wrote
 * first: that pass owns the chain from there.
 */
async function fillForwardToArrival(input: {
  threadId: string;
  /** The live conversation's arrivals: abandoned rows are already out. */
  arrivals: LiveTurnRow[];
  targetIndex: number;
  /** Abandoned user Messages, whose stored segments and logs the ledger skips. */
  abandonedIds: Set<string>;
}): Promise<Result<undefined>> {
  const { threadId, arrivals, targetIndex, abandonedIds } = input;
  const judging: JudgingParams = { ...DEFAULT_ANALYZE_OPTIONS };
  const [storedSegments, storedLogs] = await Promise.all([
    listThreadSegmentsByThread({ threadId, modelId: EMBEDDING_MODEL_ID }),
    listSegmentDriftLogsByThread({ threadId, modelId: EMBEDDING_MODEL_ID }),
  ]);
  const storedLogsByMessageId = new Map(
    storedLogs.filter((log) => !abandonedIds.has(log.messageId)).map((log) => [log.messageId, log]),
  );

  // One batch fetch of every embedding the fill reads: user-message
  // arrival rows and assistant-message turn rows.
  const wantedIds: string[] = [];
  for (let i = 0; i <= targetIndex; i += 1) {
    const row = arrivals[i];
    if (!row) continue;
    wantedIds.push(row.userMessage.id);
    if (row.assistantReply) wantedIds.push(row.assistantReply.id);
  }
  const storedRows = await listMessageEmbeddingsByMessageIds({ messageIds: wantedIds });
  const storedByMessageId = new Map(storedRows.map((row) => [row.messageId, row]));

  const state: LiveLedgerState = {
    judging,
    verdictState: createVerdictState(judging),
    memberSum: null,
    currentSegmentAnchor: null,
    anchorMemberCount: 0,
    completedTurns: 0,
    currentSegmentId: null,
    storedSegmentIdByStart: new Map(
      storedSegments.map((segment) => [segment.startMessageId, segment.id]),
    ),
    loggedMessageIds: new Set(storedLogsByMessageId.keys()),
  };

  for (let i = 0; i <= targetIndex; i += 1) {
    const row = arrivals[i];
    if (!row) continue;
    const processed = await processArrival({ state, threadId, row, storedByMessageId });
    if (processed.type === 'error') return processed;
    if (processed.data === 'written-by-another-pass') break;
  }
  return ok(undefined);
}

export const verdictAndFoldStep: MessageStep = {
  name: 'verdict-and-fold',
  async run({ threadId, userMessageId }) {
    // Abandoned rows stay out of the live ledger: their segments and drift
    // logs stay stored (usage keeps tracking them) but the chain walks and
    // folds only the live conversation.
    const rows = await listMessagesByThread({ threadId });
    const arrivals = buildLiveTurns(rows.filter((row) => !row.abandoned));
    const abandonedIds = new Set(
      rows.filter((row) => row.abandoned && row.role === 'user').map((row) => row.id),
    );
    const targetIndex = arrivals.findIndex((turn) => turn.userMessage.id === userMessageId);
    const target = targetIndex >= 0 ? arrivals[targetIndex] : undefined;
    if (!target) return err('thread_not_found');

    // Fast path: the verdict is already logged and (when the turn is
    // complete) already folded. Nothing for this step to fill.
    const logged = await findSegmentDriftLogByMessageId({
      messageId: userMessageId,
      modelId: EMBEDDING_MODEL_ID,
    });
    if (logged && (await foldComplete(target))) return ok(undefined);

    const filled = await fillForwardToArrival({ threadId, arrivals, targetIndex, abandonedIds });
    if (filled.type === 'error') return filled;
    return ok(undefined);
  },
};

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

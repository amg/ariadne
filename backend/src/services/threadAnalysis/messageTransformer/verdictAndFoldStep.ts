import { randomUUID } from 'node:crypto';
import type { Message, NewSegmentDriftLog } from '@db/types';
import { recordMessageEmbedding } from '@queries/messageEmbeddings/recordMessageEmbedding';
import {
  type OpenedSegment,
  appendArrivalVerdict,
} from '@queries/segmentDriftLogs/appendArrivalVerdict';
import { type Result, err, ok } from '../../../types/result';
import { EMBEDDING_MODEL_ID, computeEmbeddingCostUsd, embedText } from '../../aiService';
import { cosineDistance } from '../drift';
import { type Turn, formattedTurn } from '../turns';
import { DEFAULT_ANALYZE_OPTIONS, type GateVerdict } from '../types';
import { type JudgingParams, createVerdictState, evaluateAndRecord, isColdStart } from '../verdict';
import {
  type LiveChain,
  isArrivalFinished,
  readStoredJudgments,
  storedVectorOrNull,
  withEmbedding,
  withJudgment,
} from './liveChain';
import type { LiveTurnRow } from './liveTurns';
import type { MessageStep } from './messageStep';

/**
 * Verdict-and-fold step: judges the arrival against the current segment's
 * gravity point, starts a fresh segment on a fire, and folds completed
 * turns into that gravity point.
 *
 * Every run rebuilds the ledger from the pass's live chain and fills
 * forward through the target arrival: already-recorded rows are replayed
 * (never re-embedded, never re-judged), anything missing is computed,
 * persisted, and put back on the chain. The step short-circuits when the
 * target arrival already has its verdict row and its turn is folded.
 *
 * An arrival's verdict and the segments it opens commit together, and only
 * if no other pass wrote them first. A pass that finds it lost that race
 * rereads what is stored and fills forward again from there, so the
 * target always ends with the verdict the first writer stored.
 *
 * This step cannot fail open: an arrival whose embedding is missing means
 * the transformer has not finished, and the exchange surfaces the
 * failure so the retry resumes the fill-forward pass.
 */

/**
 * State one fill-forward pass accumulates across arrivals. The pass
 * creates it and folds into it in place; it never leaves the pass.
 */
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
 * Folds a completed turn into the current segment's gravity point. On fire,
 * the segment re-seeds from this turn's own vector instead of accumulating.
 * Returns the chain holding the turn's embedding.
 */
async function completeTurn(input: {
  state: LiveLedgerState;
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
  if (input.reseed || state.memberSum === null) {
    state.memberSum = [...vector];
    state.currentSegmentAnchor = [...vector];
    state.anchorMemberCount = 1;
  } else {
    state.memberSum = accumulate(state.memberSum, vector);
    if (state.anchorMemberCount < 3 && state.currentSegmentAnchor !== null) {
      state.currentSegmentAnchor = accumulate(state.currentSegmentAnchor, vector);
      state.anchorMemberCount += 1;
    }
  }
  state.completedTurns += 1;
  return ok(resolved.data.chain);
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
}): Promise<LiveChain | null> {
  const { chain, messageId, verdict, openedSegments } = input;
  if (verdict === null && openedSegments.length === 0) return chain;
  const appended = await appendArrivalVerdict({ openedSegments, verdict });
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
 * Processes one arrival during the fill-forward pass: secures its segment,
 * judges it against the live gravity point, commits the verdict when
 * missing together with the fresh segment a fire starts, and folds its
 * completed turn.
 */
async function processArrival(input: {
  state: LiveLedgerState;
  chain: LiveChain;
  row: LiveTurnRow;
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

  const judged = evaluateArrivalAgainstLedger(state, vector, userMessageId);
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
  });
  if (committed === null) return ok({ kind: 'written-by-another-pass' });

  const folded = await completeTurn({
    state,
    chain: committed,
    row,
    reseed: judged.fired,
  });
  if (folded.type === 'error') return folded;
  return ok({ kind: 'filled', chain: folded.data });
}

/**
 * Rebuilds the ledger from the live chain and processes arrivals up to
 * (inclusive of) the target index. Stored rows are replayed; anything
 * missing is computed and persisted on the spot. The chain holds only the
 * live conversation: abandoned arrivals keep their stored segments and
 * logs (usage keeps tracking them) but the ledger never walks them. Stops
 * early, without error, at the first arrival another pass wrote first.
 */
async function fillForwardToArrival(
  chain: LiveChain,
  targetIndex: number,
): Promise<Result<FillEnded>> {
  const judging: JudgingParams = { ...DEFAULT_ANALYZE_OPTIONS };
  const state: LiveLedgerState = {
    judging,
    verdictState: createVerdictState(judging),
    memberSum: null,
    currentSegmentAnchor: null,
    anchorMemberCount: 0,
    completedTurns: 0,
    currentSegmentId: null,
  };

  let current = chain;
  for (let i = 0; i <= targetIndex; i += 1) {
    const row = current.arrivals[i];
    if (!row) continue;
    const processed = await processArrival({ state, chain: current, row });
    if (processed.type === 'error') return processed;
    if (processed.data.kind === 'written-by-another-pass') return processed;
    current = processed.data.chain;
  }
  return ok({ kind: 'filled', chain: current });
}

/**
 * Fills forward until the target arrival is finished. Each lost race
 * reveals rows another pass stored and this pass had not read; with them
 * reread for the same arrivals, the next fill gets past them. So the fill
 * ends within one attempt per arrival, plus the one that finishes.
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
  const filled = await fillForwardToArrival(chain, arrivalIndex);
  if (filled.type === 'error') return filled;
  if (filled.data.kind === 'filled') return ok(filled.data.chain);
  const reread: LiveChain = { ...chain, ...(await readStoredJudgments(chain)) };
  return fillPastOtherPasses(reread, arrivalIndex, attemptsLeft - 1);
}

export const verdictAndFoldStep: MessageStep = {
  name: 'verdict-and-fold',
  run: ({ chain, arrivalIndex }) =>
    fillPastOtherPasses(chain, arrivalIndex, chain.arrivals.length + 1),
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

import { env } from '@config/env';
import type { Message, MessageEmbedding } from '@db/types';
import { listMessageEmbeddingsByMessageIds } from '@queries/messageEmbeddings/listMessageEmbeddingsByMessageIds';
import { upsertArrivalEmbedding } from '@queries/messageEmbeddings/upsertArrivalEmbedding';
import { upsertMessageEmbedding } from '@queries/messageEmbeddings/upsertMessageEmbedding';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { insertSegmentDriftLog } from '@queries/segmentDriftLogs/insertSegmentDriftLog';
import { listSegmentDriftLogsByThread } from '@queries/segmentDriftLogs/listSegmentDriftLogsByThread';
import { insertThreadSegment } from '@queries/threadSegments/insertThreadSegment';
import { listThreadSegmentsByThread } from '@queries/threadSegments/listThreadSegmentsByThread';
import { type Result, err, ok } from '../../types/result';
import {
  EMBEDDING_MODEL_ID,
  type JudgeContextDependenceInput,
  embedText,
  judgeContextDependence,
  rewriteFollowUp,
} from '../aiService';
import { computeEmbeddingCostUsd, computeInferenceCostUsd } from './cost';
import { cosineDistance } from './drift';
import {
  REWRITE_CONTEXT_LIMITS,
  REWRITE_MAX_TRIGGER_LENGTH,
  capContext,
  needsRewriteHeuristic,
  parseRewrite,
} from './rewrite';
import { type Turn, formattedProspectiveTurn, formattedTurn } from './turns';
import { DEFAULT_ANALYZE_OPTIONS, type GateVerdict } from './types';
import { type JudgingParams, createVerdictState, evaluateAndRecord, isColdStart } from './verdict';

/**
 * The live lane of the thread-health gate. Every arriving user message is
 * expanded where needed, embedded, and judged with the same two-channel
 * verdict the offline fold runs — but over arrival readings (the arriving
 * signal, rewritten or raw), while the point each arrival measures against
 * still rolls over complete Turn embeddings. The live chain is not the
 * fold's segments: a fired arrival closes the segment at itself, and the
 * next segment reseeds from the fired Turn's own vector, so the same
 * verdict on different readings may split differently than the offline
 * fold — that divergence is the calibration material, not a bug.
 * Every step persists as it completes, so backfilling threads that
 * predate the feature, recovering after a failure, and re-filling after a
 * message edit are all the same walk picking up wherever the persisted
 * chain stops — stored rows are replayed, never re-embedded or re-judged.
 */

/** The live lane's rewrite tier follows the feature flag. */
type LiveRewriteMode = 'heuristic' | 'always';

export interface LiveArrivalOutcome {
  /** Verdict on the walk's last processed arrival; null when nothing arrived. */
  verdict: GateVerdict | null;
  fireChannel: 'immediate' | 'slow' | null;
  /** The user Message the last arrival landed on; null when nothing arrived. */
  messageId: string | null;
}

type RunLiveGateProps = {
  threadId: string;
  /**
   * Judge arrivals up to and including this user Message. Absent = walk
   * every arrival in the thread (backfill / analysis-view fill).
   */
  upToMessageId?: string;
};

/** A user arrival with its exchange context — the walk's unit. */
interface LiveTurnRow {
  /** 1-based arrival ordinal: this user Message's place in the thread. */
  turnNumber: number;
  userMessage: Message;
  /** The assistant reply completing the Turn; null while the Turn is open. */
  assistantReply: Message | null;
}

/** Arrivals in chronology: one row per user Message, reply attached when present. */
function buildLiveTurns(messages: Message[]): LiveTurnRow[] {
  const turns: LiveTurnRow[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const next = messages[i + 1];
    turns.push({
      turnNumber: turns.length + 1,
      userMessage: message,
      assistantReply: next && next.role === 'assistant' ? next : null,
    });
  }
  return turns;
}

/** The complete-Turn text block a fold embeds; null while the Turn is open. */
function completeTurnOrNull(row: LiveTurnRow): { text: string; assistantMessage: Message } | null {
  if (!row.assistantReply) return null;
  const turn: Turn = {
    turnNumber: row.turnNumber,
    userMessage: row.userMessage,
    assistantMessage: row.assistantReply,
  };
  return { text: formattedTurn(turn), assistantMessage: row.assistantReply };
}

/** The vector + audit trail of one arrival's judged signal. */
interface ArrivalSignal {
  vector: number[];
  /** The self-contained rewrite the vector came from; null on the raw path. */
  rewrittenText: string | null;
}

/** The expansion outcome for one arrival: its text and this arrival's spend. */
interface ExpansionOutcome {
  rewrittenText: string | null;
  rewriteCostUsd: number | null;
  judgeCostUsd: number | null;
}

/**
 * The detached decontextualising rewrite for one arrival. Fail-open in
 * exactly the analyzer's sense: a rewrite failure or an unusable rewrite
 * is NOT a pipeline failure — the arrival keeps its raw reading and the
 * raw fast path explains itself; only a failed EMBED stops the pipeline.
 */
async function rewriteUserMessage(input: {
  incomingText: string;
  contextUserText: string;
  contextAssistantText: string;
}): Promise<ExpansionOutcome> {
  const rewritten = await rewriteFollowUp({
    contextUserText: capContext(input.contextUserText, REWRITE_CONTEXT_LIMITS.user),
    contextAssistantText: capContext(input.contextAssistantText, REWRITE_CONTEXT_LIMITS.assistant),
    followUpText: input.incomingText,
  });
  if (rewritten.type === 'error') {
    return { rewrittenText: null, rewriteCostUsd: null, judgeCostUsd: null };
  }
  const rewriteCostUsd = await computeInferenceCostUsd(
    env.REWRITE_MODEL,
    rewritten.data.usage.promptTokens,
    rewritten.data.usage.completionTokens,
  );
  return {
    rewrittenText: parseRewrite(rewritten.data.text, input.incomingText),
    rewriteCostUsd,
    judgeCostUsd: null,
  };
}

/**
 * Asks a small classifier whether a message only makes sense with the
 * prior Turn in view. Fails open: any error returns `rewrite: false`.
 */
async function needsRewrite(input: {
  incomingText: string;
  contextUserText: string;
  contextAssistantText: string;
}): Promise<{ rewrite: boolean; judgeCostUsd: number | null }> {
  const judgeInput: JudgeContextDependenceInput = {
    contextUserText: capContext(input.contextUserText, REWRITE_CONTEXT_LIMITS.user),
    contextAssistantText: capContext(input.contextAssistantText, REWRITE_CONTEXT_LIMITS.assistant),
    followUpText: input.incomingText,
  };
  const judged = await judgeContextDependence(judgeInput);
  if (judged.type === 'error') return { rewrite: false, judgeCostUsd: null };
  const judgeCostUsd = await computeInferenceCostUsd(
    env.JUDGE_MODEL,
    judged.data.usage.promptTokens,
    judged.data.usage.completionTokens,
  );
  return { rewrite: judged.data.verdict === 'context-dependent', judgeCostUsd };
}

/**
 * The expansion decision for one arrival, before any embedding: the
 * rewritten composite when the tier landed one, the raw message as the
 * audited fallback. Fail-open is always the fallback — a failed rewrite or
 * judge never blocks the reading, they just leave the raw fast path as it.
 */
async function decideRewrite(input: {
  incomingText: string;
  prior: LiveTurnRow | null;
  mode: LiveRewriteMode;
}): Promise<ExpansionOutcome> {
  const rawOutcome: ExpansionOutcome = {
    rewrittenText: null,
    rewriteCostUsd: null,
    judgeCostUsd: null,
  };
  // A first arrival has no prior exchange to resolve against — the raw
  // fast path is its only reading.
  if (!input.prior) return rawOutcome;
  const context = {
    incomingText: input.incomingText,
    contextUserText: input.prior.userMessage.content,
    contextAssistantText: input.prior.assistantReply?.content ?? '',
  };
  if (input.mode === 'always' || needsRewriteHeuristic(input.incomingText)) {
    return rewriteUserMessage(context);
  }
  const trimmed = input.incomingText.trim();
  const shortEnough = trimmed.length > 0 && trimmed.length <= REWRITE_MAX_TRIGGER_LENGTH;
  if (input.mode !== 'heuristic' || !shortEnough) return rawOutcome;
  // Second chance for short messages the heuristic missed.
  const checked = await needsRewrite(context);
  if (!checked.rewrite) {
    return { ...rawOutcome, judgeCostUsd: checked.judgeCostUsd };
  }
  const expanded = await rewriteUserMessage(context);
  return { ...expanded, judgeCostUsd: checked.judgeCostUsd };
}

/**
 * The arrival's judged signal: the rewrite tier decides the text (the
 * rewrite when one landed, the raw message as audited fallback), that
 * text embeds once as a Prospective block, and the row persists keyed to
 * the user Message — per-step spend rides the embedding row, never
 * `message_usage`. Provenance identity is the embedding model: a stored
 * row from the same model short-circuits every provider call (the
 * never-re-embed guarantee).
 */
async function resolveArrivalSignal(input: {
  row: LiveTurnRow;
  prior: LiveTurnRow | null;
  stored: MessageEmbedding | undefined;
  mode: LiveRewriteMode;
}): Promise<Result<ArrivalSignal>> {
  const stored = input.stored;
  if (stored && stored.modelId === EMBEDDING_MODEL_ID) {
    return ok({ vector: stored.embedding, rewrittenText: stored.rewrittenText });
  }

  const outcome = await decideRewrite({
    incomingText: input.row.userMessage.content,
    prior: input.prior,
    mode: input.mode,
  });

  const embedded = await embedText(
    formattedProspectiveTurn(outcome.rewrittenText ?? input.row.userMessage.content),
  );
  if (embedded.type === 'error') return embedded;
  const embeddingCostUsd = await computeEmbeddingCostUsd(embedded.data.promptTokens);

  await upsertArrivalEmbedding({
    messageId: input.row.userMessage.id,
    embedding: embedded.data.embedding,
    modelId: EMBEDDING_MODEL_ID,
    rewrittenText: outcome.rewrittenText,
    embeddingCostUsd,
    rewriteCostUsd: outcome.rewriteCostUsd,
    judgeCostUsd: outcome.judgeCostUsd,
  });

  return ok({ vector: embedded.data.embedding, rewrittenText: outcome.rewrittenText });
}

/**
 * One complete Turn's fold embed, keyed to the assistant Message — the
 * same Turn rows the offline analyzer persists; the live walk reuses them
 * through the shared upsert (provenance match short-circuits the call).
 */
async function resolveTurnVector(input: {
  text: string;
  assistantMessage: Message;
  stored: MessageEmbedding | undefined;
}): Promise<Result<number[]>> {
  const stored = input.stored;
  if (stored && stored.modelId === EMBEDDING_MODEL_ID) return ok(stored.embedding);
  const embedded = await embedText(input.text);
  if (embedded.type === 'error') return embedded;
  const row = await upsertMessageEmbedding({
    messageId: input.assistantMessage.id,
    embedding: embedded.data.embedding,
    modelId: EMBEDDING_MODEL_ID,
  });
  return ok(row.embedding);
}

/** The walk's mutable state: geometry, verdict, and persistence position. */
interface LiveWalkState {
  judging: JudgingParams;
  /** The shared two-channel verdict state (segment baseline + slow patrol). */
  verdictState: ReturnType<typeof createVerdictState>;
  /**
   * Element-wise sum of the CURRENT live segment's folded Turn vectors;
   * its unit vector is the Gravity point the next arrival measures
   * against. Null until the segment folds its first complete Turn.
   */
  memberSum: number[] | null;
  /** Complete Turns folded so far — the cold-start mute counter. */
  completedTurns: number;
  /** The live-chain segment row the next verdict logs against. */
  currentSegmentId: string | null;
  /**
   * Persisted segment rows queued ahead of the walk: a replayed fire that
   * they already cover simply advances the queue; the moment the walk
   * outruns them, new rows insert.
   */
  storedSegments: { id: string; startMessageId: string }[];
  /** Message ids the persisted chain has already logged. */
  loggedMessageIds: Set<string>;
}

/**
 * Takes the segment a verdict logs against: the next persisted chain row
 * when the walk replays over ground the chain already covered, a fresh
 * row the moment the walk outruns it. Calling this with the message id
 * the segment starts at keeps the replay and fresh paths identical.
 */
async function allocateSegment(state: LiveWalkState, threadId: string, startMessageId: string) {
  const stored = state.storedSegments.shift();
  if (stored) state.currentSegmentId = stored.id;
  else {
    const inserted = await insertThreadSegment({
      threadId,
      startMessageId,
      modelId: EMBEDDING_MODEL_ID,
    });
    state.currentSegmentId = inserted.id;
  }
}

/**
 * The live lane's entry: gate the thread's arrivals up to (and including)
 * the target Message, or fill the whole thread when no target is given.
 * Off means the walk never queues and the caller sees the empty outcome.
 * Every walk runs the fill-forward walk under per-thread serialization
 * (see `runSequentially`).
 */
export async function runLiveGate({
  threadId,
  upToMessageId,
}: RunLiveGateProps): Promise<Result<LiveArrivalOutcome>> {
  if (env.THREAD_ANALYSIS_MODE === 'off')
    return ok({ verdict: null, fireChannel: null, messageId: null });
  return runSequentially(threadId, () =>
    processLiveChain(upToMessageId === undefined ? { threadId } : { threadId, upToMessageId }),
  );
}

/**
 * One backend serves every surface, but two surfaces drive the walk at
 * once — the exchange judges up to its arrival while the analysis surface
 * backfills the thread. Each walk snapshots the chain at its start, so
 * overlapping walks re-judge and re-log arrivals the other writes after
 * the snapshot, duplicating rows. Walks on one thread therefore run
 * tightly serialized: the LATER walk re-reads the store, finds the chain
 * complete, and degrades to a pure read.
 */
const walksByThread = new Map<string, Promise<unknown>>();

function runSequentially<T>(threadId: string, walk: () => Promise<T>): Promise<T> {
  const previous = walksByThread.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const holding = new Promise<void>((resolve) => {
    release = resolve;
  });
  walksByThread.set(threadId, holding);
  // Even a broken walk hands the queue forward intactly.
  const run = previous.then(walk, walk);
  run.then(release, release);
  void run.finally(() => {
    if (walksByThread.get(threadId) === holding) walksByThread.delete(threadId);
  });
  return run;
}

/**
 * The fill-forward walk: arrives the user Messages of a thread in
 * chronology up to (and including) the target, replaying verdict and fold
 * for what the persisted chain already holds and computing + persisting
 * everything after it. Every step persists on completion — the walk is
 * safe to re-run from scratch, and a partial run loses no progress.
 *
 * Failure codes: `thread_not_found` (empty/unknown thread), plus any
 * provider failure (`provider_not_configured`, `embed_failed`) which the
 * chat route surfaces as a failed exchange.
 */
async function processLiveChain({
  threadId,
  upToMessageId,
}: RunLiveGateProps): Promise<Result<LiveArrivalOutcome>> {
  // Fresh read at walk time: a queued walk runs after whatever elapsed
  // between its surface call and its turn under the lock.
  const mode = env.THREAD_ANALYSIS_MODE;
  if (mode === 'off') return ok({ verdict: null, fireChannel: null, messageId: null });
  const rows = await listMessagesByThread({ threadId });
  const messages = rows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
  }));
  const turns = buildLiveTurns(messages);
  if (turns.length === 0) return ok({ verdict: null, fireChannel: null, messageId: null });

  let endIndex = turns.length;
  if (upToMessageId !== undefined) {
    const index = turns.findIndex((turn) => turn.userMessage.id === upToMessageId);
    if (index < 0) return err('thread_not_found');
    endIndex = index + 1;
  }

  const judging: JudgingParams = { ...DEFAULT_ANALYZE_OPTIONS };
  const rewriteMode: LiveRewriteMode = mode === 'always' ? 'always' : 'heuristic';

  const storedSegments = await listThreadSegmentsByThread({
    threadId,
    modelId: EMBEDDING_MODEL_ID,
  });
  const storedLogs = await listSegmentDriftLogsByThread({
    threadId,
    modelId: EMBEDDING_MODEL_ID,
  });

  // One batch fetch of every stored vector the walk reads — arrival rows
  // (keyed to the user Message) and Turn rows (keyed to the assistant).
  const wantedIds: string[] = [];
  for (const turn of turns) {
    wantedIds.push(turn.userMessage.id);
    if (turn.assistantReply) wantedIds.push(turn.assistantReply.id);
  }
  const storedRows = await listMessageEmbeddingsByMessageIds({ messageIds: wantedIds });
  const storedByMessageId = new Map(storedRows.map((row) => [row.messageId, row]));

  const state: LiveWalkState = {
    judging,
    verdictState: createVerdictState(judging),
    memberSum: null,
    completedTurns: 0,
    currentSegmentId: null,
    storedSegments: storedSegments.map((segment) => ({
      id: segment.id,
      startMessageId: segment.startMessageId,
    })),
    loggedMessageIds: new Set(storedLogs.map((log) => log.messageId)),
  };

  let outcome: LiveArrivalOutcome = { verdict: null, fireChannel: null, messageId: null };

  for (let i = 0; i < endIndex; i += 1) {
    const row = turns[i];
    if (!row) continue;
    const processed = await processUserMessage({
      state,
      threadId,
      row,
      prior: turns[i - 1] ?? null,
      storedVectors: storedByMessageId,
      mode: rewriteMode,
    });
    if (processed.type === 'error') return processed;
    outcome = processed.data;
  }

  return ok(outcome);
}

/** The arrival's judgment against the segment's baseline. */
interface ArrivedJudgment {
  muted: boolean;
  fired: boolean;
  fireChannel: 'immediate' | 'slow' | null;
  driftP: number | null;
  segmentMu: number | null;
  segmentSigma: number | null;
  immediateZ: number | null;
  arrivedVerdict: GateVerdict;
}

/**
 * Judge the arrival against the Gravity point the segment carries into
 * it — never mutates the fold or the chain. Judge first, fold second:
 * the arrival's own Turn contributes nothing to the reading it is
 * measured with.
 */
function evaluateArrivalAgainstLedger(state: LiveWalkState, vector: number[]): ArrivedJudgment {
  const gravity = state.memberSum === null ? null : unitVector(state.memberSum);
  const driftP = gravity === null ? null : cosineDistance(vector, gravity);
  const muted = isColdStart(state.completedTurns, state.judging, driftP);
  let fired = false;
  let judgment: ReturnType<typeof evaluateAndRecord>['judgment'] | null = null;
  if (!muted && driftP !== null) {
    ({ judgment, fired } = evaluateAndRecord(state.verdictState, state.judging, driftP));
  }
  let arrivedVerdict: GateVerdict = 'pass';
  if (muted) arrivedVerdict = 'muted';
  else if (fired) arrivedVerdict = 'fire';
  return {
    muted,
    fired,
    fireChannel: judgment?.fireChannel ?? null,
    driftP,
    segmentMu: judgment?.segmentMu ?? null,
    segmentSigma: judgment?.segmentSigma ?? null,
    immediateZ: judgment?.immediateZ ?? null,
    arrivedVerdict,
  };
}

/** Log the arrival's numbers once — replays never double-write. */
async function logArrivalIfNeeded(
  state: LiveWalkState,
  userMessageId: string,
  judged: ArrivedJudgment,
) {
  if (state.loggedMessageIds.has(userMessageId)) return;
  await insertSegmentDriftLog({
    segmentId: state.currentSegmentId as string,
    messageId: userMessageId,
    modelId: EMBEDDING_MODEL_ID,
    driftP: judged.muted ? null : judged.driftP,
    mu: judged.segmentMu,
    sigma: judged.segmentSigma,
    zScore: judged.immediateZ,
    verdict: judged.arrivedVerdict,
    fireChannel: judged.fireChannel,
  });
  state.loggedMessageIds.add(userMessageId);
}

/**
 * Fold the completion Turn — the arrival's own block joining (or
 * reseeding, after a burn) the current segment's Gravity point, exactly
 * as the offline fold does with its Boundary turns.
 */
async function completeTurn(input: {
  state: LiveWalkState;
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
  } else {
    state.memberSum = accumulate(state.memberSum, folded.data);
  }
  state.completedTurns += 1;
  return ok(undefined);
}

/**
 * One arrival, judged and persisted: embeds and judges through the shared
 * verdict core, logs its numbers once, rotates the live chain forward on a
 * burn, and folds the completed Turn into the segment's Gravity point.
 * This is the walk's only mutating step, so it is also the only place
 * signals persist.
 */
async function processUserMessage(input: {
  state: LiveWalkState;
  threadId: string;
  row: LiveTurnRow;
  prior: LiveTurnRow | null;
  storedVectors: Map<string, MessageEmbedding>;
  mode: LiveRewriteMode;
}): Promise<Result<LiveArrivalOutcome>> {
  const { state, threadId, row } = input;
  const userMessageId = row.userMessage.id;

  // The live chain opens its first segment with the thread's own opening
  // arrival; a replayed chain already holds it in the queue.
  if (state.currentSegmentId === null) {
    await allocateSegment(state, threadId, userMessageId);
  }

  const signal = await resolveArrivalSignal({
    row,
    prior: input.prior,
    stored: input.storedVectors.get(userMessageId),
    mode: input.mode,
  });
  if (signal.type === 'error') return signal;

  const judged = evaluateArrivalAgainstLedger(state, signal.data.vector);
  await logArrivalIfNeeded(state, userMessageId, judged);

  if (judged.fired) {
    // The fired arrival burned the segment it was judged in: the next
    // segment starts at the SAME message and its Gravity point reseeds
    // from the fired Turn's own vector once that Turn folds.
    state.memberSum = null;
    await allocateSegment(state, threadId, userMessageId);
  }

  const folded = await completeTurn({
    state,
    row,
    assistantStored: row.assistantReply
      ? input.storedVectors.get(row.assistantReply.id)
      : undefined,
    reseed: judged.fired,
  });
  if (folded.type === 'error') return folded;

  return ok({
    verdict: judged.arrivedVerdict,
    fireChannel: judged.fireChannel,
    messageId: userMessageId,
  });
}

/** Adds the member vector into the segment's element-wise running sum. */
function accumulate(sum: number[], vector: number[]): number[] {
  for (let i = 0; i < sum.length; i += 1) {
    sum[i] = (sum[i] ?? 0) + (vector[i] ?? 0);
  }
  return sum;
}

/** Renormalizes to unit length; the Gravity point rides a unit vector. */
function unitVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) throw new Error('gravity point collapsed to zero');
  return vector.map((value) => value / norm);
}

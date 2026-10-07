import { env } from '@config/env';
import type { Message } from '@db/types';
import { getMessageUsageByMessageId } from '@queries/messageUsage/getMessageUsageByMessageId';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { secondsUntilUtcMidnight, sumDailySpend } from '@queries/messageUsage/sumDailySpend';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import { updateExchangeStatus } from '@queries/messages/updateExchangeStatus';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { inTransaction } from '@queries/transaction/inTransaction';
import type { ThreadGenerateTitleParams } from '@queue/tasks/threadGenerateTitleTask';
import { type MemoryFeature, assembledSystemPrompt } from '@services/memory';
import { validateMessageContent } from '@services/validation';
import type { ModelMessage } from 'ai';
import { type UIMessageChunk, streamText, toUIMessageStream } from 'ai';
import { type Result, type ResultError, err, errBudgetExceeded, ok } from '../../types/result';
import { renameThread } from '../threadService';
import {
  type Arrival,
  type ArrivalGateOutcome,
  type ArrivalJudging,
  type ArrivalVerdict,
  type VerdictListener,
  awaitArrivalGate,
  listenForVerdict,
  storedGateOutcomeOrNull,
} from './arrivalGate';
import {
  NOT_CONFIGURED_MESSAGE,
  SYSTEM_PROMPT,
  createModel,
  isInferenceConfigured,
  resolveInferenceConfig,
} from './config';
import { ChatExchange, type ChatOutcome } from './exchange';
import { pausedArrivalOrNull } from './pausedArrival';
import { buildEstimatedUsageRow, estimateChatPromptTokens } from './usageMap';

/**
 * Per-call service boundary. Flow:
 *   1. verify thread ownership,
 *   2. resolve the user turn (insert it on `submitChat`, together with its
 *      queued Drift gate judgment; reuse the newest live user row on
 *      `retryLastExchange`),
 *   3. wait, briefly, for the Drift gate's verdict on that arrival. No
 *      reply is ever generated for an arrival the gate has not judged: a
 *      clear verdict starts the Exchange on this same response, a fire
 *      pauses it, and an arrival still being judged when the wait runs
 *      out, or one the gate could not judge, gets no reply yet,
 *   4. `streamText` over the full thread history, with the Thread's Seed
 *      prepended to the system prompt and inter-token idle timeout
 *      watched by the exchange,
 *   5. `ChatExchange` persists text + usage as the stream settles.
 */

export type ChatStreamHandle = {
  assistantMessageId: string;
  /** UI message stream (SSE-ready, consumable by `useChat`). */
  stream: ReadableStream<UIMessageChunk>;
  /** Settles once the stream has ended and persistence has completed. */
  outcome: Promise<Result<ChatOutcome>>;
  /** Aborts the provider stream from the outside (user stop). */
  abort: () => void;
  /**
   * The live gate's verdict on the exchange's arriving user Message, for
   * the advisory bubble signal; null on retries (no new arrival) and when
   * the feature flag is off.
   */
  threadVerdict?: ArrivalVerdict;
};

/**
 * A submit whose arrival the gate fired on: the user Message is stored,
 * no Exchange started. It waits for the user to continue in this Thread
 * or hand it over to a fresh one.
 */
export type DriftPause = {
  paused: true;
  threadVerdict: ArrivalVerdict & { verdict: 'fire' };
};

export type ChatSubmission = ChatStreamHandle | DriftPause;

export function isDriftPause(submission: ChatSubmission): submission is DriftPause {
  return 'paused' in submission;
}

/** Queues the titling a Thread owes once its first Exchange settles. */
export interface ThreadTitling {
  enqueueThreadGenerateTitle(params: ThreadGenerateTitleParams): Promise<void>;
}

type SubmitChatProps = {
  userId: string;
  threadId: string;
  content: string;
  judging: ArrivalJudging;
  titling: ThreadTitling;
  memory: MemoryFeature;
  /** Aborts when the client stops waiting; the judgment carries on without it. */
  signal?: AbortSignal;
};

/**
 * What the user asks of a retry. `continue` is the choice to keep a Paused
 * arrival in its Thread: its stored fire is replayed and the reply runs.
 * A plain `retry` of a Paused arrival only reports the pause again.
 */
export type RetryChoice = 'retry' | 'continue';

type RetryLastExchangeProps = {
  userId: string;
  threadId: string;
  choice: RetryChoice;
  judging: ArrivalJudging;
  titling: ThreadTitling;
  memory: MemoryFeature;
  /** Aborts when the client stops waiting; the judgment carries on without it. */
  signal?: AbortSignal;
};

const STREAM_ERROR_MESSAGE = 'The assistant hit an error while generating the reply.';

/** Abandoned threads title from the arrival text; capped at the rename limit. */
const ABANDONED_TITLE_MAX_CHARS = 50;

/** Short preview of the arrival text that titles a still-untitled thread. */
function abandonedTitlePreview(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= ABANDONED_TITLE_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, ABANDONED_TITLE_MAX_CHARS - 1).trimEnd()}\u2026`;
}

/** System prompt + prior turns (user/assistant only) + the new user turn.
 * Abandoned turns stay out of inference memory — no history to learn from.
 * Empty assistant rows (interrupted before first token) stay in the DB/UI
 * but are skipped in the model context.
 */
function buildModelMessages(
  history: Awaited<ReturnType<typeof listMessagesByThread>>,
  userMessage: Message,
): ModelMessage[] {
  return [
    ...history
      .filter(
        (row) =>
          (row.role === 'user' || row.role === 'assistant') &&
          !row.abandoned &&
          (row.role === 'user' || row.content !== ''),
      )
      .map((row) => ({ role: row.role, content: row.content })),
    { role: userMessage.role, content: userMessage.content },
  ];
}

type StartExchangeProps = {
  userId: string;
  threadId: string;
  /** Turns preceding the user turn (already persisted). */
  precedingRows: Awaited<ReturnType<typeof listMessagesByThread>>;
  /** The user turn the exchange responds to. */
  userMessage: Message;
  titling: ThreadTitling;
  memory: MemoryFeature;
};

/**
 * One exchange per thread at a time, and the lazy half of staleness
 * recovery. A newest assistant row still `pending` means an exchange is
 * live and a second start would bill another inference over the same
 * history — bounce it. A pending row older than the staleness window
 * belongs to a dead process: settle it as interrupted here so the thread
 * moves on; callers rely on this running on every start.
 *
 * Check-before-insert, not serialization: two starts racing the whole way
 * (two submits meeting across the live gate's latency, today a same-tab
 * race only) both pass it. Atomic enforcement belongs on the pending
 * insert itself — the tracked index hardening lands before multi-replica
 * deployment.
 */
/**
 * Settles a crashed exchange: status + estimated spend (no abandonment
 * flags — interruption/failure never abandons). Best effort: a racing
 * process may have settled first.
 */
async function settleCrashedExchange(
  rows: Awaited<ReturnType<typeof listMessagesByThread>>,
  assistantMessage: (typeof rows)[number],
  assistantIndex: number,
  systemPrompt: string,
): Promise<void> {
  await updateExchangeStatus({ messageId: assistantMessage.id, exchangeStatus: 'interrupted' });

  let promptRow: (typeof rows)[number] | undefined;
  let promptIndex = -1;
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    if (rows[i]?.role === 'user') {
      promptRow = rows[i];
      promptIndex = i;
      break;
    }
  }
  const promptTokens = promptRow
    ? estimateChatPromptTokens(
        systemPrompt,
        buildModelMessages(rows.slice(0, promptIndex), promptRow),
      )
    : 0;
  try {
    await insertMessageUsage(
      await buildEstimatedUsageRow({
        messageId: assistantMessage.id,
        model: resolveInferenceConfig().model,
        promptTokens,
        streamedText: assistantMessage.content,
        finishReason: 'interrupted',
        latencyMs: null,
      }),
    );
  } catch {
    // A racing process may have settled first.
  }
}

async function guardOrSettleStaleExchange(
  rows: Awaited<ReturnType<typeof listMessagesByThread>>,
  scope: { userId: string; threadId: string; memory: MemoryFeature },
): Promise<ResultError | null> {
  let newestAssistantIndex = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.role === 'assistant') {
      newestAssistantIndex = i;
      break;
    }
  }
  const newestAssistant = newestAssistantIndex >= 0 ? rows[newestAssistantIndex] : undefined;
  if (!newestAssistant || newestAssistant.exchangeStatus !== 'pending') return null;

  const ageMs = Date.now() - newestAssistant.createdAt.getTime();
  if (ageMs <= env.EXCHANGE_STALENESS_MS) {
    return err('exchange_in_flight', 'An exchange is already running in this thread.');
  }

  const systemPrompt = await assembledSystemPrompt({ ...scope, basePrompt: SYSTEM_PROMPT });
  await settleCrashedExchange(rows, newestAssistant, newestAssistantIndex, systemPrompt);
  return null;
}

/** Shared tail of both entry points: assistant row + provider stream. */
async function startExchange({
  userId,
  threadId,
  precedingRows,
  userMessage,
  titling,
  memory,
}: StartExchangeProps): Promise<ChatStreamHandle> {
  const config = resolveInferenceConfig();
  const assistantMessage = await insertMessage({
    threadId,
    role: 'assistant',
    content: '',
    // Marks the exchange running until settlement flips it; the guard in
    // submitChat/retryLastExchange bounces concurrent starts on this row.
    exchangeStatus: 'pending',
  });

  const controller = new AbortController();
  const modelMessages = buildModelMessages(precedingRows, userMessage);
  const systemPrompt = await assembledSystemPrompt({
    userId,
    threadId,
    basePrompt: SYSTEM_PROMPT,
    memory,
  });

  const exchange = new ChatExchange({
    assistantMessageId: assistantMessage.id,
    model: config.model,
    // If the provider's usage report never arrives, the spend is still
    // accounted from the locally counted input tokens.
    promptTokensEstimate: estimateChatPromptTokens(systemPrompt, modelMessages),
    idleTimeoutMs: config.idleTimeoutMs,
    // Fires on the idle deadline; user stop / client disconnect reuse the controller.
    onIdleTimeout: () => controller.abort(),
  });

  // An exchange ending without completing stays in the thread: the user
  // arrival and its partial reply likely remain, the partial joins the
  // context of whatever comes next, and the user decides its fate — reword
  // (an explicit replacement), edit (a fork), or build on top. A still-
  // untitled thread titles from the arrival text so the listing stays
  // navigable. A completed exchange titles through the queue instead, so
  // the title lands whether or not the browser stays open. Best effort —
  // the outcome and spend settlement are authoritative.
  void exchange.outcome.then(async (result) => {
    try {
      const thread = await findThreadByIdAndUser({ userId, threadId });
      if (!thread || thread.title) return;
      if (result.type === 'success' && result.data.finishReason !== 'interrupted') {
        await titling.enqueueThreadGenerateTitle({ userId, threadId, forced: false });
        return;
      }
      await renameThread({ userId, threadId, title: abandonedTitlePreview(userMessage.content) });
    } catch {
      // Titling must not fail the exchange.
    }
  });

  const streamResult = streamText({
    model: createModel(config),
    // With reasoning disabled the model skips its thinking phase entirely,
    // rather than thinking unseen.
    ...(config.enableReasoning
      ? {}
      : { providerOptions: { deepinfra: { chat_template_kwargs: { enable_thinking: false } } } }),
    system: systemPrompt,
    messages: modelMessages,
    abortSignal: controller.signal,
    maxRetries: 0,
    onChunk: ({ chunk }) => {
      if (chunk.type === 'text-delta') {
        // Accumulate text and (re-)arm the exchange's inter-token idle timer.
        exchange.recordTextDelta(chunk.text);
      } else if (chunk.type === 'reasoning-delta') {
        // @ts-expect-error property might not be correctly typed in current version
        exchange.recordReasoningDelta(chunk.textDelta);
      }
    },
    // ai v7 fires onAbort (not onEnd) when the stream is aborted.
    onAbort: async () => {
      await exchange.completeAbort();
    },
    onEnd: async (event) => {
      await exchange.completeNatural({
        finishReason: event.finishReason,
        usage: event.usage,
        providerId: event.response?.id,
      });
    },
    onError: async ({ error }) => {
      await exchange.completeError(error);
    },
  });

  const stream = toUIMessageStream({
    stream: streamResult.fullStream,
    // Pin the streamed assistant message to our persisted row so revalidation
    // maps the DB state onto the same bubble.
    generateMessageId: () => assistantMessage.id,
    onError: () => STREAM_ERROR_MESSAGE,
    // Enable reasoning output if configured - frontend shows it in collapsible section
    sendReasoning: config.enableReasoning,
  });

  return {
    assistantMessageId: assistantMessage.id,
    stream,
    outcome: exchange.outcome,
    abort: () => controller.abort(),
  };
}

/**
 * The refusal a submit gets while the newest live row is an arrival with
 * no reply: nothing else enters the Thread until it is answered. A Paused
 * arrival waits for the user's choice; any other waits for its retry.
 * Null when the Thread is free.
 */
async function unansweredArrivalErrorOrNull(rows: Message[]): Promise<ResultError | null> {
  const newestLive = rows.filter((row) => !row.abandoned).at(-1);
  if (newestLive?.role !== 'user') return null;
  if (await pausedArrivalOrNull(rows)) {
    return err(
      'arrival_paused',
      'The last message changed the topic: continue it in this thread or start a new chat from it first.',
    );
  }
  return err('arrival_unanswered', 'The last message has no reply yet: retry it first.');
}

/**
 * Stores the arrival and queues its judgment in one transaction, with a
 * listener already open for the verdict: the judgment cannot land before
 * anyone hears it.
 */
async function storeArrival(
  { userId, threadId, content }: { userId: string; threadId: string; content: string },
  judging: ArrivalJudging,
): Promise<{ userMessage: Message; listener: VerdictListener }> {
  const opened: { listener?: VerdictListener } = {};
  try {
    return await inTransaction(async (trx) => {
      const userMessage = await insertMessage({ threadId, role: 'user', content }, trx);
      const arrival: Arrival = { userId, threadId, messageId: userMessage.id };
      opened.listener = listenForVerdict(arrival);
      await judging.enqueueDriftGateJudgeArrival(arrival, trx);
      return { userMessage, listener: opened.listener };
    });
  } catch (error) {
    opened.listener?.close();
    throw error;
  }
}

/**
 * What a chat request answers once the gate has spoken: the Exchange on a
 * clear verdict, the pause on a fire (unless the user chose to continue
 * past it), and no reply while the verdict is missing.
 */
async function submissionForGate(
  gate: ArrivalGateOutcome,
  pauseOnFire: boolean,
  exchange: StartExchangeProps,
): Promise<Result<ChatSubmission>> {
  if (gate.kind === 'pending') {
    return err('gate_pending', 'The message is still being checked. Try again shortly.');
  }
  if (gate.kind === 'failed') return err('gate_failed', 'The message could not be checked.');
  if (gate.kind === 'paused' && pauseOnFire) {
    return ok({ paused: true, threadVerdict: gate.verdict });
  }
  const handle = await startExchange(exchange);
  if (gate.verdict) handle.threadVerdict = gate.verdict;
  return ok(handle);
}

export async function submitChat({
  userId,
  threadId,
  content,
  judging,
  titling,
  memory,
  signal,
}: SubmitChatProps): Promise<Result<ChatSubmission>> {
  const contentResult = validateMessageContent(content);
  if (contentResult.type === 'error') return contentResult;
  const normalized = contentResult.data;

  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) return err('thread_not_found');

  const config = resolveInferenceConfig();
  if (!isInferenceConfigured(config)) {
    return err('provider_not_configured', NOT_CONFIGURED_MESSAGE);
  }

  // Global daily spend budget gate — checked before any Exchange starts.
  // Unset DAILY_SPEND_BUDGET_USD = fail open, no gate.
  const budget = env.DAILY_SPEND_BUDGET_USD;
  if (budget !== undefined) {
    const dailyTotal = await sumDailySpend();
    if (Number(dailyTotal) >= budget) {
      return errBudgetExceeded(
        secondsUntilUtcMidnight(),
        'Daily spend budget exceeded. Try again after UTC midnight.',
      );
    }
  }

  const precedingRows = await listMessagesByThread({ threadId });
  const inFlight = await guardOrSettleStaleExchange(precedingRows, { userId, threadId, memory });
  if (inFlight) return inFlight;
  const unanswered = await unansweredArrivalErrorOrNull(precedingRows);
  if (unanswered) return unanswered;

  const { userMessage, listener } = await storeArrival(
    { userId, threadId, content: normalized },
    judging,
  );
  const gate = await awaitArrivalGate({
    arrival: { userId, threadId, messageId: userMessage.id },
    listener,
    judging,
    ...(signal === undefined ? {} : { signal }),
  });
  return submissionForGate(gate, true, {
    userId,
    threadId,
    precedingRows,
    userMessage,
    titling,
    memory,
  });
}

/**
 * User-initiated retry of the last inference (useChat `regenerate` trigger).
 * The server is authoritative — the client's message list is ignored. The
 * retry targets the newest live user turn (an abandoned arrival, such as
 * one handed over to another Thread, is never revived).
 *
 * An arrival already answered is re-exchanged: the stale assistant rows
 * beneath it are flagged abandoned in place — the rows stay, their usage
 * keeps tracking what the failed run burned — and the regenerate lands
 * beneath them. An arrival with no reply yet waits on the Drift gate the
 * way a submit does, queueing its judgment again when none is under way.
 * A Paused arrival continues in its Thread only when the user chooses
 * `continue`; a plain retry reports the pause again.
 */
export async function retryLastExchange({
  userId,
  threadId,
  choice,
  judging,
  titling,
  memory,
  signal,
}: RetryLastExchangeProps): Promise<Result<ChatSubmission>> {
  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) return err('thread_not_found');

  const config = resolveInferenceConfig();
  if (!isInferenceConfigured(config)) {
    return err('provider_not_configured', NOT_CONFIGURED_MESSAGE);
  }

  const rows = await listMessagesByThread({ threadId });
  const last = rows[rows.length - 1];
  if (!last) return err('nothing_to_regenerate');

  const inFlight = await guardOrSettleStaleExchange(rows, { userId, threadId, memory });
  if (inFlight) return inFlight;

  let userIndex = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.role === 'user' && !rows[i]?.abandoned) {
      userIndex = i;
      break;
    }
  }
  const userMessage = userIndex >= 0 ? rows[userIndex] : undefined;
  if (!userMessage) return err('nothing_to_regenerate');

  const exchange: StartExchangeProps = {
    userId,
    threadId,
    precedingRows: rows.slice(0, userIndex),
    userMessage,
    titling,
    memory,
  };
  const staleReplyIds = rows
    .slice(userIndex + 1)
    .filter((row) => row.role === 'assistant' && !row.abandoned)
    .map((row) => row.id);
  if (staleReplyIds.length > 0) {
    await setMessagesAbandoned({ messageIds: staleReplyIds, abandoned: true });
    const handle = await startExchange(exchange);
    const stored = await storedGateOutcomeOrNull(userMessage.id);
    if (stored?.verdict) handle.threadVerdict = stored.verdict;
    return ok(handle);
  }

  const arrival: Arrival = { userId, threadId, messageId: userMessage.id };
  const gate = await awaitArrivalGate({
    arrival,
    listener: listenForVerdict(arrival),
    judging,
    ...(signal === undefined ? {} : { signal }),
  });
  return submissionForGate(gate, choice !== 'continue', exchange);
}

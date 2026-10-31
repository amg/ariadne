import { randomUUID } from 'node:crypto';
import type { ThreadAnalysisMode } from '@ari/lib/api/schemas/threads/analysis';
import { env } from '@config/env';
import type { Message } from '@db/types';
import { insertMessageUsageIfAbsent } from '@queries/messageUsage/insertMessageUsageIfAbsent';
import { secondsUntilUtcMidnight, sumDailySpend } from '@queries/messageUsage/sumDailySpend';
import { findPromptOfReplyOrNull } from '@queries/messages/findPromptOfReplyOrNull';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertPendingReplyOrNull } from '@queries/messages/insertPendingReplyOrNull';
import { listModelHistoryByThread } from '@queries/messages/listModelHistoryByThread';
import { listNewestRowsByThread } from '@queries/messages/listNewestRowsByThread';
import { lockLiveMessage } from '@queries/messages/lockLiveMessage';
import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import { updateExchangeStatus } from '@queries/messages/updateExchangeStatus';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { inTransaction } from '@queries/transaction/inTransaction';
import { enqueueDriftGateFoldTurn } from '@queue/tasks/driftGateFoldTurnTask';
import type { enqueueThreadGenerateTitle } from '@queue/tasks/threadGenerateTitleTask';
import { assembledSystemPrompt } from '@services/memory';
import { validateMessageContent } from '@services/validation';
import type { ModelMessage } from 'ai';
import { streamText, toUIMessageStream } from 'ai';
import type {
  Arrival,
  ArrivalJudging,
  ChatStreamHandle,
  DriftPause,
  RetryChoice,
} from '../../types/aiService';
import type { ExchangeLog } from '../../types/appRecords';
import type { MemoryFeature } from '../../types/memory';
import { type Result, type ResultError, err, errBudgetExceeded, ok } from '../../types/result';
import { renameThread } from '../threadService';
import { awaitArrivalGate, listenForVerdict, storedGateOutcomeOrNull } from './arrivalGate';
import { logBestEffortFailure } from './bestEffortLogging';
import {
  NOT_CONFIGURED_MESSAGE,
  SYSTEM_PROMPT,
  createModel,
  isInferenceConfigured,
  resolveInferenceConfig,
} from './config';
import { ChatExchange } from './exchange';
import { logGateOutcome, recordingExchange } from './exchangeLogging';
import { newestLiveUserIndex } from './newestLiveUser';
import { pausedArrivalOrNull } from './pausedArrival';
import { buildEstimatedUsageRow, estimateChatPromptTokens } from './usageMap';

type ThreadGenerateTitleParams = Parameters<typeof enqueueThreadGenerateTitle>[0];

type ArrivalGateOutcome = Awaited<ReturnType<typeof awaitArrivalGate>>;
type ChatSubmission = ChatStreamHandle | DriftPause;

export function isDriftPause(submission: ChatSubmission): submission is DriftPause {
  return 'paused' in submission;
}

/** Queues the titling a Thread owes once its first Exchange settles. */
interface ThreadTitling {
  enqueueThreadGenerateTitle(params: ThreadGenerateTitleParams): Promise<void>;
}

type SubmitChatProps = {
  userId: string;
  threadId: string;
  content: string;
  judging: ArrivalJudging;
  titling: ThreadTitling;
  memory: MemoryFeature;
  threadAnalysisMode: ThreadAnalysisMode;
  /** Aborts when the client stops waiting; the judgment carries on without it. */
  signal?: AbortSignal;
};
type RetryLastExchangeProps = {
  userId: string;
  threadId: string;
  choice: RetryChoice;
  judging: ArrivalJudging;
  titling: ThreadTitling;
  memory: MemoryFeature;
  threadAnalysisMode: ThreadAnalysisMode;
  /** Aborts when the client stops waiting; the judgment carries on without it. */
  signal?: AbortSignal;
};

const STREAM_ERROR_MESSAGE = 'The assistant hit an error while generating the reply.';

/** Abandoned threads title from the arrival text; capped at the rename limit. */
const ABANDONED_TITLE_MAX_CHARS = 50;

/** Short preview of the arrival text that titles a still-untitled thread. */
function abandonedTitlePreview(content: string) {
  const trimmed = content.trim();
  if (trimmed.length <= ABANDONED_TITLE_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, ABANDONED_TITLE_MAX_CHARS - 1).trimEnd()}\u2026`;
}

/** The Thread's conversation before a user turn, as the model reads it. */
type ModelHistory = Awaited<ReturnType<typeof listModelHistoryByThread>>;

/** Prior turns + the new user turn, as the model receives them. */
function buildModelMessages({
  history,
  userMessage,
}: {
  history: ModelHistory;
  userMessage: Message;
}): ModelMessage[] {
  return [
    ...history.map((row) => ({ role: row.role, content: row.content })),
    { role: userMessage.role, content: userMessage.content },
  ];
}

/**
 * What a starting Exchange does with the replies already beneath its
 * arrival: `answer` starts the first one and finds none, `regenerate`
 * abandons them and starts a fresh one beneath.
 */
type ExchangeStartMode = 'answer' | 'regenerate';

type StartExchangeProps = {
  userId: string;
  threadId: string;
  /** The user turn the exchange responds to. */
  userMessageId: string;
  mode: ExchangeStartMode;
  titling: ThreadTitling;
  memory: MemoryFeature;
  exchangeLog: ExchangeLog;
};

/**
 * Settles a crashed exchange: status + estimated spend (no abandonment
 * flags — interruption/failure never abandons). The spend row is best
 * effort: a process that settled first keeps its row, and a failed write
 * is recorded without blocking the new Exchange.
 */
async function settleCrashedExchange({
  threadId,
  assistantMessage,
  systemPrompt,
}: {
  threadId: string;
  assistantMessage: Message;
  systemPrompt: string;
}) {
  await updateExchangeStatus({ messageId: assistantMessage.id, exchangeStatus: 'interrupted' });

  const promptRow = await findPromptOfReplyOrNull({ threadId, replyId: assistantMessage.id });
  const promptTokens = promptRow
    ? estimateChatPromptTokens({
        systemPrompt,
        messages: buildModelMessages({
          history: await listModelHistoryByThread({ threadId, beforeMessageId: promptRow.id }),
          userMessage: promptRow,
        }),
      })
    : 0;
  try {
    await insertMessageUsageIfAbsent(
      await buildEstimatedUsageRow({
        messageId: assistantMessage.id,
        model: resolveInferenceConfig().model,
        promptTokens,
        streamedText: assistantMessage.content,
        finishReason: 'interrupted',
        latencyMs: null,
      }),
    );
  } catch (error) {
    logBestEffortFailure({ step: 'persistEstimatedSpend', error });
  }
}

/**
 * The daily spend budget gate, shared by every way an Exchange starts and
 * checked before any billable work, the Drift gate included. Null when the
 * budget is unset or not yet reached.
 */
async function budgetExceededErrorOrNull(): Promise<ResultError | null> {
  const budget = env.DAILY_SPEND_BUDGET_USD;
  if (budget === undefined) return null;
  const dailyTotal = await sumDailySpend();
  if (Number(dailyTotal) < budget) return null;
  return errBudgetExceeded(secondsUntilUtcMidnight());
}

/** Whether a `pending` reply is young enough that its process may still be streaming it. */
function isLivePending(row: Message | undefined): row is Message {
  if (row?.exchangeStatus !== 'pending') return false;
  return Date.now() - row.createdAt.getTime() <= env.EXCHANGE_STALENESS_MS;
}

const EXCHANGE_IN_FLIGHT_MESSAGE = 'An exchange is already running in this thread.';

/**
 * One exchange per thread at a time, and the lazy half of staleness
 * recovery. A newest assistant row still `pending` means an exchange is
 * live and a second start would bill another inference over the same
 * history: bounce it. A pending row older than the staleness window
 * belongs to a dead process: settle it as interrupted here so the thread
 * moves on. Run on rows read before the gate wait, it only refuses early;
 * the claim re-runs it on fresh rows, and the database refuses a second
 * pending reply whatever the rows said. The rows must hold the Thread's
 * newest assistant Message.
 */
async function guardOrSettleStaleExchange({
  rows,
  userId,
  threadId,
  memory,
}: {
  rows: readonly Message[];
  userId: string;
  threadId: string;
  memory: MemoryFeature;
}) {
  const newestAssistant = rows.findLast((row) => row.role === 'assistant');
  if (newestAssistant?.exchangeStatus !== 'pending') return null;
  if (isLivePending(newestAssistant)) return err('exchange_in_flight', EXCHANGE_IN_FLIGHT_MESSAGE);

  const systemPrompt = await assembledSystemPrompt({
    userId,
    threadId,
    memory,
    basePrompt: SYSTEM_PROMPT,
  });
  await settleCrashedExchange({ threadId, assistantMessage: newestAssistant, systemPrompt });
  return null;
}

/** The live replies grown beneath the user Message at `userIndex`. */
function liveReplyIdsBeneath({ rows, userIndex }: { rows: Message[]; userIndex: number }) {
  return rows
    .slice(userIndex + 1)
    .filter((row) => row.role === 'assistant' && !row.abandoned)
    .map((row) => row.id);
}

type ClaimedExchange = {
  userMessage: Message;
  /** The `pending` reply row the Exchange settles. */
  assistantMessage: Message;
};

/**
 * Claims the Thread's one running Exchange for an arrival, deciding from
 * the Thread as it stands now rather than as the caller last read it.
 * Claims and edits of one arrival take their turns on its row: of several
 * requests waiting on the same arrival only the first wins, and an edit
 * either abandons the claimed reply with its arrival or leaves nothing to
 * claim.
 *
 * Failure codes: `arrival_abandoned` when the arrival is no longer the
 * newest live user Message, `arrival_answered` when an `answer` finds a
 * reply already beneath it, `exchange_in_flight` when another Exchange is
 * still running.
 */
async function claimExchange({
  userId,
  threadId,
  userMessageId,
  mode,
  memory,
}: StartExchangeProps) {
  return inTransaction(async (trx): Promise<Result<ClaimedExchange>> => {
    // Locked before the read, so the read sees what the one ahead left.
    const live = await lockLiveMessage({ threadId, messageId: userMessageId }, trx);
    const rows = await listNewestRowsByThread({ threadId }, trx);
    const userIndex = newestLiveUserIndex(rows);
    const userMessage = rows[userIndex];
    if (!live || userMessage?.id !== userMessageId) {
      return err('arrival_abandoned', 'The message was edited or moved before its reply started.');
    }
    const replyIds = liveReplyIdsBeneath({ rows, userIndex });
    if (mode === 'answer' && replyIds.length > 0) {
      return err('arrival_answered', 'The message is already being answered.');
    }
    const inFlight = await guardOrSettleStaleExchange({ rows, userId, threadId, memory });
    if (inFlight) return inFlight;

    const assistantMessage = await insertPendingReplyOrNull({ threadId }, trx);
    if (!assistantMessage) return err('exchange_in_flight', EXCHANGE_IN_FLIGHT_MESSAGE);
    await setMessagesAbandoned({ messageIds: replyIds, abandoned: true }, trx);
    return ok({ userMessage, assistantMessage });
  });
}

/** Claims the reply row for the arrival and starts the provider stream into it. */
async function startExchange(props: StartExchangeProps): Promise<Result<ChatStreamHandle>> {
  const claimed = await claimExchange(props);
  if (claimed.type === 'error') return claimed;
  const { userId, threadId, titling, memory, exchangeLog } = props;
  const { userMessage, assistantMessage } = claimed.data;
  const config = resolveInferenceConfig();

  const controller = new AbortController();
  // Read after the claim commits: the turns before the claimed arrival
  // are settled, and the claim's transaction stays short.
  const history = await listModelHistoryByThread({ threadId, beforeMessageId: userMessage.id });
  const modelMessages = buildModelMessages({ history, userMessage });
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
    // accounted from the locally counted input tokens — counted only then.
    estimatePromptTokens: () => estimateChatPromptTokens({ systemPrompt, messages: modelMessages }),
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

  // The reply completes a Turn: its fold is queue work, off the next
  // arrival's judgment path. Best effort on every settle — a lost enqueue
  // costs the next judgment one inline fold, nothing more.
  void exchange.outcome.then(() => {
    enqueueDriftGateFoldTurn({ threadId, messageId: assistantMessage.id }).catch((error) => {
      logBestEffortFailure({ step: 'enqueueFoldTurn', error });
    });
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
        exchange.recordTextDelta(chunk.text);
        exchangeLog.logFirstToken();
      } else if (chunk.type === 'reasoning-delta') {
        exchange.recordReasoningDelta(chunk.text);
        exchangeLog.logFirstToken();
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
    sendReasoning: config.enableReasoning,
  });

  return ok({
    assistantMessageId: assistantMessage.id,
    stream,
    outcome: exchange.outcome,
    abort: () => controller.abort(),
  });
}

/**
 * The refusal a submit gets while the newest live row is an arrival with
 * no reply: nothing else enters the Thread until it is answered. A Paused
 * arrival waits for the user's choice; any other waits for its retry.
 * Null when the Thread is free.
 */
async function unansweredArrivalErrorOrNull(rows: Message[]) {
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
 * listener already sure to hear the verdict: the judgment cannot land
 * before anyone hears it.
 */
async function storeArrival({
  userId,
  threadId,
  content,
  judging,
}: {
  userId: string;
  threadId: string;
  content: string;
  judging: ArrivalJudging;
}) {
  const arrival: Arrival = { userId, threadId, messageId: randomUUID() };
  const listener = listenForVerdict(arrival);
  try {
    await listener.ready;
    const userMessage = await inTransaction(async (trx) => {
      const stored = await insertMessage(
        { id: arrival.messageId, threadId, role: 'user', content },
        trx,
      );
      await judging.enqueueDriftGateJudgeArrival(arrival, trx);
      return stored;
    });
    return { userMessage, listener };
  } catch (error) {
    listener.close();
    throw error;
  }
}

/**
 * What a chat request answers once the gate has spoken: the Exchange on a
 * clear verdict, the pause on a fire (unless the user chose to continue
 * past it), and no reply while the verdict is missing or once the client
 * has left: nobody would read it.
 */
async function submissionForGate({
  gate,
  pauseOnFire,
  exchange,
  signal,
}: {
  gate: ArrivalGateOutcome;
  pauseOnFire: boolean;
  exchange: StartExchangeProps;
  signal: AbortSignal | undefined;
}): Promise<Result<ChatSubmission>> {
  switch (gate.kind) {
    case 'gone':
      return err('client_gone', 'The client left before the gate answered.');
    case 'pending':
      return err('gate_pending', 'The message is still being checked. Try again shortly.');
    case 'failed':
      return err('gate_failed', 'The message could not be checked.');
    case 'paused':
      if (pauseOnFire) return ok({ paused: true, threadVerdict: gate.verdict });
      break;
    case 'clear':
      break;
    default: {
      const _check: never = gate;
      return _check;
    }
  }
  if (signal?.aborted) return err('client_gone', 'The client left before the reply started.');
  const started = await startExchange(exchange);
  if (started.type === 'success' && gate.verdict) started.data.threadVerdict = gate.verdict;
  return started;
}

/**
 * Submits a user message to a Thread and answers with its reply stream or
 * its pause. The request is written down as an Exchange record when it ends.
 *
 * Flow:
 *   1. verify thread ownership,
 *   2. resolve the user turn (insert it on `submitChat`, together with its
 *      queued Drift gate judgment; reuse the newest live user row on
 *      `retryLastExchange`),
 *   3. wait, briefly, for the Drift gate's verdict on that arrival. No
 *      reply is ever generated for an arrival the gate has not judged: a
 *      clear verdict starts the Exchange on this same response, a fire
 *      pauses it, and an arrival still being judged when the wait runs
 *      out, or one the gate could not judge, gets no reply yet,
 *   4. claim the Exchange from the Thread as it stands after the wait,
 *      one start per arrival at a time: an arrival edited away or already
 *      answered meanwhile gets no second reply,
 *   5. stream the reply over the full thread history, with the Thread's
 *      Seed prepended to the system prompt; a stream that goes quiet
 *      between tokens for too long ends the Exchange,
 *   6. store the reply text and its usage as the stream settles.
 */
export function submitChat(props: SubmitChatProps): Promise<Result<ChatSubmission>> {
  return recordingExchange({
    request: { userId: props.userId, trigger: 'submit' },
    run: (exchangeLog) => submitArrival({ ...props, exchangeLog }),
  });
}

async function submitArrival({
  userId,
  threadId,
  content,
  judging,
  titling,
  memory,
  threadAnalysisMode,
  signal,
  exchangeLog,
}: SubmitChatProps & { exchangeLog: ExchangeLog }): Promise<Result<ChatSubmission>> {
  const contentResult = validateMessageContent(content);
  if (contentResult.type === 'error') return contentResult;
  const normalized = contentResult.data;

  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) return err('thread_not_found');

  const config = resolveInferenceConfig();
  if (!isInferenceConfigured(config)) {
    return err('provider_not_configured', NOT_CONFIGURED_MESSAGE);
  }

  const overBudget = await budgetExceededErrorOrNull();
  if (overBudget) return overBudget;

  const newestRows = await listNewestRowsByThread({ threadId });
  const inFlight = await guardOrSettleStaleExchange({
    rows: newestRows,
    userId,
    threadId,
    memory,
  });
  if (inFlight) return inFlight;
  const unanswered = await unansweredArrivalErrorOrNull(newestRows);
  if (unanswered) return unanswered;

  const { userMessage, listener } = await storeArrival({
    userId,
    threadId,
    content: normalized,
    judging,
  });
  const gate = await awaitArrivalGate({
    arrival: { userId, threadId, messageId: userMessage.id },
    listener,
    judging,
    threadAnalysisMode,
    ...(signal === undefined ? {} : { signal }),
  });
  logGateOutcome({ exchangeLog, gate, trigger: 'submit' });
  return submissionForGate({
    gate,
    pauseOnFire: true,
    exchange: {
      userId,
      threadId,
      userMessageId: userMessage.id,
      mode: 'answer',
      titling,
      memory,
      exchangeLog,
    },
    signal,
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
export function retryLastExchange(props: RetryLastExchangeProps): Promise<Result<ChatSubmission>> {
  return recordingExchange({
    request: { userId: props.userId, trigger: 'retry' },
    run: (exchangeLog) => retryExchange({ ...props, exchangeLog }),
  });
}

async function retryExchange({
  userId,
  threadId,
  choice,
  judging,
  titling,
  memory,
  threadAnalysisMode,
  signal,
  exchangeLog,
}: RetryLastExchangeProps & { exchangeLog: ExchangeLog }): Promise<Result<ChatSubmission>> {
  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) return err('thread_not_found');

  const config = resolveInferenceConfig();
  if (!isInferenceConfigured(config)) {
    return err('provider_not_configured', NOT_CONFIGURED_MESSAGE);
  }

  const overBudget = await budgetExceededErrorOrNull();
  if (overBudget) return overBudget;

  const rows = await listNewestRowsByThread({ threadId });
  const last = rows[rows.length - 1];
  if (!last) return err('nothing_to_regenerate');

  const inFlight = await guardOrSettleStaleExchange({ rows, userId, threadId, memory });
  if (inFlight) return inFlight;

  const userIndex = newestLiveUserIndex(rows);
  const userMessage = rows[userIndex];
  if (!userMessage) return err('nothing_to_regenerate');

  const exchange = {
    userId,
    threadId,
    userMessageId: userMessage.id,
    titling,
    memory,
    exchangeLog,
  };
  if (liveReplyIdsBeneath({ rows, userIndex }).length > 0) {
    const stored = await storedGateOutcomeOrNull(userMessage.id);
    if (stored) {
      logGateOutcome({
        exchangeLog,
        gate: { ...stored, storedBeforeWait: true },
        trigger: 'retry',
      });
    }
    const started = await startExchange({ ...exchange, mode: 'regenerate' });
    if (started.type === 'error') return started;
    if (stored?.verdict) started.data.threadVerdict = stored.verdict;
    return started;
  }

  const arrival: Arrival = { userId, threadId, messageId: userMessage.id };
  const gate = await awaitArrivalGate({
    arrival,
    listener: listenForVerdict(arrival),
    judging,
    threadAnalysisMode,
    ...(signal === undefined ? {} : { signal }),
  });
  logGateOutcome({ exchangeLog, gate, trigger: 'retry' });
  return submissionForGate({
    gate,
    pauseOnFire: choice !== 'continue',
    exchange: { ...exchange, mode: 'answer' },
    signal,
  });
}

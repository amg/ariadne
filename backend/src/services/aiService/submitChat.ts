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
import { runLiveGate } from '@services/threadAnalysis';
import type { ModelMessage } from 'ai';
import { type UIMessageChunk, streamText, toUIMessageStream } from 'ai';
import { type Result, type ResultError, err, errBudgetExceeded, ok } from '../../types/result';
import { renameThread } from '../threadService';
import {
  NOT_CONFIGURED_MESSAGE,
  SYSTEM_PROMPT,
  createModel,
  isInferenceConfigured,
  resolveInferenceConfig,
} from './config';
import { ChatExchange, type ChatOutcome } from './exchange';
import { buildEstimatedUsageRow, estimateChatPromptTokens } from './usageMap';

/**
 * Per-call service boundary. Flow:
 *   1. verify thread ownership,
 *   2. resolve the user turn (insert it on `submitChat`, reuse the persisted
 *      last user row on `retryLastExchange`),
 *   3. run the live thread-health gate on the arriving user Message:
 *      expansion → embed → the shared two-channel verdict → persist,
 *      awaited before inference; a pipeline failure fails the whole
 *      exchange. Retries re-run the gate too — already-analysed
 *      arrivals replay (never re-embedded/re-judged), while a freshly
 *      forked arrival (an edit) is gated for the first time there;
 *   4. `streamText` over the full thread history, with inter-token idle
 *      timeout watched by the exchange,
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
  threadVerdict?: {
    messageId: string;
    verdict: 'muted' | 'pass' | 'fire';
    fireChannel: 'immediate' | 'slow' | null;
  };
};

type SubmitChatProps = {
  userId: string;
  threadId: string;
  content: string;
};

type RetryLastExchangeProps = {
  userId: string;
  threadId: string;
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
        SYSTEM_PROMPT,
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

  await settleCrashedExchange(rows, newestAssistant, newestAssistantIndex);
  return null;
}

/** Shared tail of both entry points: assistant row + provider stream. */
async function startExchange({
  userId,
  threadId,
  precedingRows,
  userMessage,
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

  const exchange = new ChatExchange({
    assistantMessageId: assistantMessage.id,
    model: config.model,
    // If the provider's usage report never arrives, the spend is still
    // accounted from the locally counted input tokens.
    promptTokensEstimate: estimateChatPromptTokens(SYSTEM_PROMPT, modelMessages),
    idleTimeoutMs: config.idleTimeoutMs,
    // Fires on the idle deadline; user stop / client disconnect reuse the controller.
    onIdleTimeout: () => controller.abort(),
  });

  // An exchange ending without completing stays in the thread: the user
  // arrival and its partial reply likely remain, the partial joins the
  // context of whatever comes next, and the user decides its fate — reword
  // (an explicit replacement), edit (a fork), or build on top. A still-
  // untitled thread titles from the arrival text so the listing stays
  // navigable. Best effort — the outcome and spend settlement are
  // authoritative.
  void exchange.outcome.then(async (result) => {
    if (result.type === 'success' && result.data.finishReason !== 'interrupted') return;
    try {
      const thread = await findThreadByIdAndUser({ userId, threadId });
      if (thread && !thread.title) {
        await renameThread({ userId, threadId, title: abandonedTitlePreview(userMessage.content) });
      }
    } catch {
      // Titling must not fail the exchange.
    }
  });

  const streamResult = streamText({
    model: createModel(config),
    system: SYSTEM_PROMPT,
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

export async function submitChat({
  userId,
  threadId,
  content,
}: SubmitChatProps): Promise<Result<ChatStreamHandle>> {
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
  const inFlight = await guardOrSettleStaleExchange(precedingRows);
  if (inFlight) return inFlight;

  const userMessage = await insertMessage({ threadId, role: 'user', content });

  // The live gate judges the arriving message before inference: the
  // pipeline persists every step as it completes, so a failure leaves the
  // user row in place (regenerate retries the exchange) and a later
  // arrival backfills whatever this run did not finish.
  const gate = await runLiveGate({ threadId, upToMessageId: userMessage.id });
  if (gate.type === 'error') return gate;

  const handle = await startExchange({ userId, threadId, precedingRows, userMessage });
  if (gate.data.verdict !== null && gate.data.messageId !== null) {
    handle.threadVerdict = {
      messageId: gate.data.messageId,
      verdict: gate.data.verdict,
      fireChannel: gate.data.fireChannel,
    };
  }
  return ok(handle);
}

/**
 * User-initiated retry of the last inference (useChat `regenerate` trigger).
 * The server is authoritative — the client's message list is ignored. The
 * retry revives the newest user turn it re-exchanges (a turn of exchange-
 * debris returns to the live conversation) and flags the stale assistant
 * rows beneath it abandoned in place — the rows stay, their usage keeps
 * tracking what the failed run burned, and the regenerate lands beneath
 * them.
 */
export async function retryLastExchange({
  userId,
  threadId,
}: RetryLastExchangeProps): Promise<Result<ChatStreamHandle>> {
  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) return err('thread_not_found');

  const config = resolveInferenceConfig();
  if (!isInferenceConfigured(config)) {
    return err('provider_not_configured', NOT_CONFIGURED_MESSAGE);
  }

  const rows = await listMessagesByThread({ threadId });
  const last = rows[rows.length - 1];
  if (!last) return err('nothing_to_regenerate');

  const inFlight = await guardOrSettleStaleExchange(rows);
  if (inFlight) return inFlight;

  // The target is the newest user turn — revived: an abandoned arrival
  // re-joining the live conversation, its stale assistant rows overrun by
  // the regenerate.
  let userIndex = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.role === 'user') {
      userIndex = i;
      break;
    }
  }
  const userMessage = userIndex >= 0 ? rows[userIndex] : undefined;
  if (!userMessage) return err('nothing_to_regenerate');

  await setMessagesAbandoned({ messageIds: [userMessage.id], abandoned: false });
  // Stale answers stay — flagged abandoned with their usage rows intact,
  // the honest cost of the failed run; the regenerate lands beneath them.
  await setMessagesAbandoned({
    messageIds: rows
      .slice(userIndex + 1)
      .filter((row) => row.role === 'assistant' && !row.abandoned)
      .map((row) => row.id),
    abandoned: true,
  });

  // The exchanged arrival is gated: already-analysed arrivals replay
  // (never re-embedded, never re-judged — cheap and idempotent), while a
  // freshly forked arrival — an edit abandoned the old text there and
  // inserted this row — is gated for the first time here.
  const gate = await runLiveGate({ threadId, upToMessageId: userMessage.id });
  if (gate.type === 'error') return gate;

  const handle = await startExchange({
    userId,
    threadId,
    precedingRows: rows.slice(0, userIndex),
    userMessage,
  });
  if (gate.data.verdict !== null && gate.data.messageId !== null) {
    handle.threadVerdict = {
      messageId: gate.data.messageId,
      verdict: gate.data.verdict,
      fireChannel: gate.data.fireChannel,
    };
  }
  return ok(handle);
}

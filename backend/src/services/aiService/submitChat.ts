import type { Message } from '@db/types';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import type { ModelMessage } from 'ai';
import { type UIMessageChunk, streamText, toUIMessageStream } from 'ai';
import { type Result, err, ok } from '../../types/result';
import {
  SYSTEM_PROMPT,
  createModel,
  isInferenceConfigured,
  resolveInferenceConfig,
} from './config';
import { ChatExchange, type ChatOutcome } from './exchange';

/**
 * Per-call service boundary (see features/ai-connector/MVP.md). Flow:
 *   1. verify thread ownership,
 *   2. insert user + assistant rows (assistant empty until streamed),
 *   3. `streamText` over the full thread history, with inter-token idle
 *      timeout watched by the exchange,
 *   4. `ChatExchange` persists text + usage as the stream settles.
 */

export type ChatStreamHandle = {
  assistantMessageId: string;
  /** UI message stream (SSE-ready, consumable by `useChat`). */
  stream: ReadableStream<UIMessageChunk>;
  /** Settles once the stream has ended and persistence has completed. */
  outcome: Promise<Result<ChatOutcome>>;
  /** Aborts the provider stream from the outside (user stop). */
  abort: () => void;
};

type SubmitChatProps = {
  userId: string;
  threadId: string;
  content: string;
};

const NOT_CONFIGURED_MESSAGE =
  'Neither MOCK_AI_BASE_URL (mock) nor DEEPINFRA_API_KEY (real provider) is set.';

const STREAM_ERROR_MESSAGE = 'The assistant hit an error while generating the reply.';

/** System prompt + prior turns (user/assistant only) + the new user turn. */
function buildModelMessages(
  history: Awaited<ReturnType<typeof listMessagesByThread>>,
  userMessage: Message,
): ModelMessage[] {
  return [
    ...history
      .filter((row) => row.role === 'user' || row.role === 'assistant')
      .map((row) => ({ role: row.role, content: row.content })),
    { role: userMessage.role, content: userMessage.content },
  ];
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

  const history = await listMessagesByThread({ threadId });
  const userMessage = await insertMessage({ thread_id: threadId, role: 'user', content });
  const assistantMessage = await insertMessage({
    thread_id: threadId,
    role: 'assistant',
    content: '',
  });

  const controller = new AbortController();
  const exchange = new ChatExchange({
    assistantMessageId: assistantMessage.id,
    model: config.model,
    idleTimeoutMs: config.idleTimeoutMs,
    // Fires on the idle deadline; user stop / client disconnect reuse the controller.
    onIdleTimeout: () => controller.abort(),
  });

  const streamResult = streamText({
    model: createModel(config),
    system: SYSTEM_PROMPT,
    messages: buildModelMessages(history, userMessage),
    abortSignal: controller.signal,
    maxRetries: 0,
    onChunk: ({ chunk }) => {
      if (chunk.type === 'text-delta') {
        // Accumulate text and (re-)arm the exchange's inter-token idle timer.
        exchange.recordTextDelta(chunk.text);
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
  });

  return ok({
    assistantMessageId: assistantMessage.id,
    stream,
    outcome: exchange.outcome,
    abort: () => controller.abort(),
  });
}

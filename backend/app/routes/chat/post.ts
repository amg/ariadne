import { randomUUID } from 'node:crypto';
import {
  type ChatStreamHandle,
  type DriftPause,
  clearActiveExchange,
  isDriftPause,
  registerActiveExchange,
  retryLastExchange,
  submitChat,
} from '@services/aiService';
import { isValidUuid } from '@services/validation';
import { type UIMessage, createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { Result } from '../../../src/types/result';

type ThreadParams = {
  id: string;
};

type ChatRequestBody = {
  messages?: UIMessage[];
  /** useChat transport trigger: 'submit-message' | 'regenerate-message' | 'resume-stream'. */
  trigger?: string;
};

/** The `useChat` POST contains the client's message list; we take the last user text. */
function extractLastUserText(messages: ChatRequestBody['messages']): string {
  if (!messages) return '';
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  if (!lastUser) return '';
  return lastUser.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

/** Failures where the thread's state forbids the exchange, with their fallback text. */
const CONFLICT_MESSAGES: Record<string, string> = {
  arrival_paused: 'The last message is waiting for a choice.',
  nothing_to_regenerate: 'The thread has no exchange to retry.',
  exchange_in_flight: 'An exchange is already running in this thread.',
};

/** Maps exchange startup failures to responses; null means "keep streaming". */
function sendExchangeError(
  reply: FastifyReply,
  result: Extract<Result<ChatStreamHandle>, { type: 'error' }>,
): void {
  const conflict = CONFLICT_MESSAGES[result.code];
  if (conflict !== undefined) {
    reply.code(409).send({ error: result.message ?? conflict });
    return;
  }
  // Unknown thread and foreign thread stay indistinguishable (404).
  if (result.code === 'thread_not_found') {
    reply.code(404).send({ error: 'Thread not found' });
    return;
  }
  // Budget exceeded — 429 with Retry-After header (seconds until UTC midnight).
  if (result.code === 'budget_exceeded') {
    // Type guard: BudgetExceededError has retryAfter, StandardError doesn't
    if ('retryAfter' in result) {
      reply.header('Retry-After', String(result.retryAfter));
      reply.code(429).send({
        error: result.message ?? 'Daily spend budget exceeded.',
        retryAfter: result.retryAfter,
      });
    }
    return;
  }
  // Failure-swap classes the UI can act on (vs the generic 500).
  if (result.code === 'provider_not_configured') {
    reply.code(503).send({ error: result.message ?? 'AI provider is not configured.' });
    return;
  }
  if (result.code === 'embed_failed') {
    reply
      .code(502)
      .send({ error: result.message ?? 'The thread analysis pipeline failed to embed.' });
    return;
  }
  reply.code(500).send({ error: 'Failed to start the AI exchange.' });
}

/** Streams an exchange handle to the client; a disconnect aborts the provider. */
function createStreamResponse(reply: FastifyReply, threadId: string, handle: ChatStreamHandle) {
  // Client disconnect (user stop / closed tab) aborts the provider stream, which
  // persists the partial text as 'interrupted'. Use the *response* raw socket:
  // under Fastify v5 + current Node the IncomingMessage 'close'/'aborted' events
  // don't fire for streaming responses, but the ServerResponse 'close' does.
  let finished = false;
  void handle.outcome.finally(() => {
    finished = true;
    clearActiveExchange(threadId, handle);
  });
  reply.raw.on('close', () => {
    if (!finished) handle.abort();
  });

  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      // The live gate's verdict rides the stream as the FIRST event: the
      // arrival was judged before inference ran, so the UI tints the user
      // bubble before the reply starts growing. Transient — the settled
      // verdict lives on the persisted signal, not the message parts.
      if (handle.threadVerdict) {
        writer.write({
          type: 'data-thread-verdict',
          id: randomUUID(),
          data: {
            messageId: handle.threadVerdict.messageId,
            verdict: handle.threadVerdict.verdict,
            fireChannel: handle.threadVerdict.fireChannel,
          },
          transient: true,
        });
      }
      writer.merge(handle.stream);
    },
    onError: () => 'An error occurred while generating the reply.',
  });
  return createUIMessageStreamResponse({ stream });
}

/**
 * Streams a paused arrival: the verdict event alone, then the stream ends
 * with no reply. The UI marks the message and offers the choice.
 */
function createPauseResponse(pause: DriftPause) {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({
        type: 'data-thread-verdict',
        id: randomUUID(),
        data: pause.threadVerdict,
        transient: true,
      });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

/**
 * Responds to a submit or a retry: an exchange stream, a pause, or an
 * error. A retry carries no content.
 */
async function respondToChat(
  reply: FastifyReply,
  input: { userId: string; threadId: string; content: string | null },
) {
  const { userId, threadId, content } = input;
  const result =
    content === null
      ? await retryLastExchange({ userId, threadId })
      : await submitChat({ userId, threadId, content });
  if (result.type === 'error') return sendExchangeError(reply, result);
  if (isDriftPause(result.data)) return createPauseResponse(result.data);
  registerActiveExchange(input.threadId, result.data);
  return createStreamResponse(reply, input.threadId, result.data);
}

export async function setupChatPostRoute(fastify: FastifyInstance) {
  fastify.post(
    '/api/threads/:id/chat',
    {
      // Each request triggers a billable DeepInfra call — throttle hard.
      preHandler: verifySession(),
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (
      request: FastifyRequest<{ Params: ThreadParams; Body: ChatRequestBody }>,
      reply: FastifyReply,
    ) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const { id: threadId } = request.params;
      if (!isValidUuid(threadId)) {
        return reply.code(400).send({ error: 'Invalid thread id' });
      }

      const trigger = request.body?.trigger;
      if (
        trigger !== undefined &&
        trigger !== 'submit-message' &&
        trigger !== 'regenerate-message'
      ) {
        return reply.code(400).send({ error: `Unsupported trigger: ${trigger}` });
      }

      // Retry of the last inference (useChat `regenerate()`). The server is
      // authoritative: DB state decides the exchange, client messages ignored.
      if (trigger === 'regenerate-message') {
        return respondToChat(reply, { userId, threadId, content: null });
      }

      const content = extractLastUserText(request.body?.messages);
      if (!content) {
        return reply.code(400).send({ error: 'Missing message content' });
      }

      return respondToChat(reply, { userId, threadId, content });
    },
  );
}

import { randomUUID } from 'node:crypto';
import { type ChatStreamHandle, retryLastExchange, submitChat } from '@services/aiService';
import { DEFAULT_USER_ID } from '@services/userService';
import { isValidUuid } from '@services/validation';
import { type UIMessage, createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Result } from '../../../src/types/result';

// Placeholder until page-level auth resolves the user.
const REQUEST_USER_ID = DEFAULT_USER_ID;

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

/** Maps exchange startup failures to responses; null means "keep streaming". */
function sendExchangeError(
  reply: FastifyReply,
  result: Result<ChatStreamHandle> & { type: 'error' },
): void {
  // Unknown thread and foreign thread stay indistinguishable (404).
  if (result.code === 'thread_not_found') {
    reply.code(404).send({ error: 'Thread not found' });
    return;
  }
  if (result.code === 'nothing_to_regenerate') {
    reply.code(409).send({ error: 'The thread has no exchange to retry.' });
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
function createStreamResponse(request: FastifyRequest, handle: ChatStreamHandle) {
  // Client disconnect (user stop / closed tab) aborts the provider stream,
  // which persists the partial text as 'interrupted'.
  let finished = false;
  void handle.outcome.finally(() => {
    finished = true;
  });
  request.raw.on('close', () => {
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

export async function setupChatPostRoute(fastify: FastifyInstance) {
  fastify.post(
    '/api/threads/:id/chat',
    {
      // Each request triggers a billable DeepInfra call — throttle hard.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (
      request: FastifyRequest<{ Params: ThreadParams; Body: ChatRequestBody }>,
      reply: FastifyReply,
    ) => {
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
        const result = await retryLastExchange({ userId: REQUEST_USER_ID, threadId });
        if (result.type === 'error') {
          return sendExchangeError(reply, result);
        }
        return createStreamResponse(request, result.data);
      }

      const content = extractLastUserText(request.body?.messages);
      if (!content) {
        return reply.code(400).send({ error: 'Missing message content' });
      }

      const result = await submitChat({ userId: REQUEST_USER_ID, threadId, content });
      if (result.type === 'error') {
        return sendExchangeError(reply, result);
      }
      return createStreamResponse(request, result.data);
    },
  );
}

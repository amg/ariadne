import { submitChat } from '@services/aiService';
import { DEFAULT_USER_ID } from '@services/userService';
import { type UIMessage, createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Placeholder until page-level auth resolves the user.
const REQUEST_USER_ID = DEFAULT_USER_ID;

type ThreadParams = {
  id: string;
};

type ChatRequestBody = {
  messages?: UIMessage[];
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

export async function setupChatPostRoute(fastify: FastifyInstance) {
  fastify.post(
    '/api/threads/:id/chat',
    async (
      request: FastifyRequest<{ Params: ThreadParams; Body: ChatRequestBody }>,
      reply: FastifyReply,
    ) => {
      const { id: threadId } = request.params;
      const content = extractLastUserText(request.body?.messages);
      if (!content) {
        return reply.code(400).send({ error: 'Missing message content' });
      }

      const result = await submitChat({ userId: REQUEST_USER_ID, threadId, content });
      if (result.type === 'error') {
        // Unknown thread and foreign thread stay indistinguishable (404).
        if (result.code === 'thread_not_found') {
          return reply.code(404).send({ error: 'Thread not found' });
        }
        if (result.code === 'provider_not_configured') {
          return reply
            .code(503)
            .send({ error: result.message ?? 'AI provider is not configured.' });
        }
        return reply.code(500).send({ error: 'Failed to start the AI exchange.' });
      }

      const handle = result.data;

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
          writer.merge(handle.stream);
        },
        onError: () => 'An error occurred while generating the reply.',
      });
      return createUIMessageStreamResponse({ stream });
    },
  );
}

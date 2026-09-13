import { submitMessage } from '@services/messageService';
import { DEFAULT_USER_ID } from '@services/userService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Placeholder until page-level auth resolves the user.
const REQUEST_USER_ID = DEFAULT_USER_ID;

type ThreadParams = {
  id: string;
};

type CreateMessageBody = {
  content: string;
};

export async function setupMessagesPostRoute(fastify: FastifyInstance) {
  fastify.post(
    '/api/threads/:id/messages',
    async (
      request: FastifyRequest<{ Params: ThreadParams; Body: CreateMessageBody }>,
      reply: FastifyReply,
    ) => {
      const { id: threadId } = request.params;
      const { content } = request.body;

      // Save user message + generate & save assistant response (service layer)
      const result = await submitMessage({ userId: REQUEST_USER_ID, threadId, content });
      if (!result) {
        // Unknown thread and foreign thread are intentionally indistinguishable.
        return reply.code(404).send({ error: 'Thread not found' });
      }

      // Return the message json for now (will be swapped for SSE stream later)
      return reply.send({ message: result.assistantMessage });
    },
  );
}

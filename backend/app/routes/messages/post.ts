import { db } from '@db/db';
import { submitMessage } from '@services/messageService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

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
      const { assistantMessage } = await submitMessage(db, threadId, content);

      // Return the message json for now (will be swapped for SSE stream later)
      return reply.send({ message: assistantMessage });
    },
  );
}

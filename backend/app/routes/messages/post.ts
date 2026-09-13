import { createMessage, createMockResponse } from '@services/messageService';
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

      // Save User Message
      await createMessage({
        thread_id: threadId,
        role: 'user',
        content: content,
      });

      // Mock AI Response
      const aiMessage = await createMockResponse(threadId, content);

      // Return the message json for now (will be swapped for SSE stream later)
      return reply.send({ message: aiMessage });
    },
  );
}

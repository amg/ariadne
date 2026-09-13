import { getMessages } from '@services/messageService';
import { DEFAULT_USER_ID } from '@services/userService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Placeholder until page-level auth resolves the user.
const REQUEST_USER_ID = DEFAULT_USER_ID;

type ThreadParams = {
  id: string;
};

export async function setupMessagesGetRoute(fastify: FastifyInstance) {
  fastify.get('/api/threads/:id/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as ThreadParams;
    const messages = await getMessages({ userId: REQUEST_USER_ID, threadId: params.id });
    if (!messages) {
      // Unknown thread and foreign thread are intentionally indistinguishable.
      return reply.code(404).send({ error: 'Thread not found' });
    }
    return reply.send(messages);
  });
}

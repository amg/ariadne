import { getMessages } from '@services/messageService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type ThreadParams = {
  id: string;
};

export async function setupMessagesGetRoute(fastify: FastifyInstance) {
  fastify.get('/api/threads/:id/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as ThreadParams;
    const messages = await getMessages(params.id);
    return reply.send(messages);
  });
}

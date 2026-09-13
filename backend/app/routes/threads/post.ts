import { createThread } from '@services/threadService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type CreateThreadBody = {
  title?: string;
};

export async function setupThreadsPostRoute(fastify: FastifyInstance) {
  fastify.post('/api/threads', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CreateThreadBody;
    const thread = await createThread(body.title);
    return reply.send(thread);
  });
}

import { getThreads } from '@services/threadService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export async function setupThreadsGetRoute(fastify: FastifyInstance) {
  fastify.get('/api/threads', async (_request: FastifyRequest, reply: FastifyReply) => {
    const threads = await getThreads();
    return reply.send(threads);
  });
}

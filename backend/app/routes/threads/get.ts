import { getThreads } from '@services/threadService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';

export async function setupThreadsGetRoute(fastify: FastifyInstance) {
  fastify.get(
    '/api/threads',
    { preHandler: verifySession() },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const userId = (_request as SessionRequest).session?.getUserId() as string;
      const threads = await getThreads({ userId: userId });
      return reply.send(threads);
    },
  );
}

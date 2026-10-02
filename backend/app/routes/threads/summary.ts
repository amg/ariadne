import { getThreadSummary } from '@services/threadSummaryService';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';

type ThreadParams = {
  id: string;
};

export async function setupThreadSummaryRoute(fastify: FastifyInstance) {
  fastify.get(
    '/api/threads/:id/summary',
    { preHandler: verifySession() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const params = request.params as ThreadParams;
      if (!isValidUuid(params.id)) {
        return reply.code(400).send({ error: 'Invalid thread id' });
      }
      const summary = await getThreadSummary({ userId: userId, threadId: params.id });
      if (!summary) {
        return reply.code(404).send({ error: 'Thread not found' });
      }
      return reply.send(summary);
    },
  );
}

import { threadSummary } from '@ari/lib/api/schemas/threads/summary';
import { getThreadSummary } from '@services/threadSummaryService';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { RouteOf } from '../contract';
import { threadIdOrReject, userIdOf } from '../request';

export function setupThreadSummaryRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof threadSummary>>({
    method: threadSummary.method,
    url: threadSummary.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const threadId = threadIdOrReject({ request, reply });
      if (threadId === null) return reply;
      const summary = await getThreadSummary({ userId, threadId });
      if (!summary) return reply.code(404).send({ error: 'Thread not found' });
      return reply.code(200).send(summary);
    },
  });
}

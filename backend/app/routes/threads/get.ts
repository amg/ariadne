import { listThreads } from '@ari/lib/api/schemas/threads/thread';
import { getThreads } from '@services/threadService';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { RouteOf } from '../contract';
import { userIdOf } from '../request';

export function setupThreadsGetRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof listThreads>>({
    method: listThreads.method,
    url: listThreads.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      return reply.code(200).send(await getThreads({ userId }));
    },
  });
}

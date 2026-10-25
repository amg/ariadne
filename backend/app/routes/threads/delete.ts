import { deleteThread as deleteThreadEndpoint } from '@ari/lib/api/schemas/threads/thread';
import { deleteThread } from '@services/threadService';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { RouteOf } from '../contract';
import { threadIdOrReject, userIdOf } from '../request';

export function setupThreadsDeleteRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof deleteThreadEndpoint>>({
    method: deleteThreadEndpoint.method,
    url: deleteThreadEndpoint.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const threadId = threadIdOrReject({ request, reply });
      if (threadId === null) return reply;

      const deleted = await deleteThread({ userId, threadId });
      if (!deleted) return reply.code(404).send({ error: 'Thread not found' });
      return reply.code(204).send();
    },
  });
}

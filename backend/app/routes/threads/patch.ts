import { renameThread as renameThreadEndpoint } from '@ari/lib/api/schemas/threads/thread';
import { ThreadValidationError, renameThread } from '@services/threadService';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import { type RouteOf, parsedOrNull } from '../contract';
import { threadIdOrReject, userIdOf } from '../request';

export function setupThreadsPatchRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof renameThreadEndpoint>>({
    method: renameThreadEndpoint.method,
    url: renameThreadEndpoint.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const threadId = threadIdOrReject({ request, reply });
      if (threadId === null) return reply;
      const body = parsedOrNull(renameThreadEndpoint.body, request.body);
      if (!body) return reply.code(400).send({ error: 'title must be a string' });

      try {
        const thread = await renameThread({ userId, threadId, title: body.title });
        if (!thread) return reply.code(404).send({ error: 'Thread not found' });
        return reply.code(200).send(thread);
      } catch (err) {
        if (err instanceof ThreadValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  });
}

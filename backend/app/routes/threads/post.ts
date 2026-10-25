import { createThread as createThreadEndpoint } from '@ari/lib/api/schemas/threads/thread';
import { ThreadValidationError, createThread } from '@services/threadService';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { MemoryFeature } from '../../../src/types/memory';
import type { RouteOf } from '../contract';
import { userIdOf } from '../request';

export function setupThreadsPostRoute(
  fastify: FastifyInstance,
  { memory }: { memory: MemoryFeature },
) {
  fastify.route<RouteOf<typeof createThreadEndpoint>>({
    method: createThreadEndpoint.method,
    url: createThreadEndpoint.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      try {
        return reply.code(200).send(await createThread({ userId, memory }));
      } catch (err) {
        if (err instanceof ThreadValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  });
}

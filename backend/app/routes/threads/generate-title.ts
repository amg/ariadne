import { generateTitle } from '@ari/lib/api/schemas/threads/generate-title';
import { enqueueThreadGenerateTitle } from '@queue/tasks/threadGenerateTitleTask';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import { type RouteOf, parsedOrNull } from '../contract';
import { ownedThreadIdOrReject, userIdOf } from '../request';

/**
 * Queues the thread's titling and answers at once; the title lands with
 * the queue and reaches open tabs through the push channel. Regeneration
 * (`forced`) names the thread from its first segment and replaces any
 * title it already has. 404, with nothing queued, for a Thread the user
 * does not own.
 */
export function setupThreadsGenerateTitleRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof generateTitle>>({
    method: generateTitle.method,
    url: generateTitle.path,
    preHandler: verifySession(),
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const threadId = await ownedThreadIdOrReject({ request, reply, userId });
      if (threadId === null) return reply;
      const body = parsedOrNull(generateTitle.body, request.body ?? {});
      if (!body) return reply.code(400).send({ error: 'forced must be a boolean' });

      await enqueueThreadGenerateTitle({
        userId,
        threadId,
        forced: body.forced === true,
      });
      return reply.code(202).send({ success: true, queued: true });
    },
  });
}

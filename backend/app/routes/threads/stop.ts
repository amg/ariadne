import { stopExchange } from '@ari/lib/api/schemas/threads/stop';
import { stopThreadExchange } from '@services/aiService';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { RouteOf } from '../contract';
import { ownedThreadIdOrReject, userIdOf } from '../request';

/**
 * User stop for the thread's live exchange, on whichever backend copy
 * streams it: aborts the provider stream, which settles the exchange as
 * `interrupted` (partial text + estimated spend persist). The connection-close path does the same for a vanished
 * client; this endpoint makes the stop explicit and callable — 200 except
 * 404 when nothing is running.
 */
export function setupThreadStopRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof stopExchange>>({
    method: stopExchange.method,
    url: stopExchange.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const threadId = await ownedThreadIdOrReject({ request, reply, userId });
      if (threadId === null) return reply;
      const stopped = await stopThreadExchange({ userId, threadId });
      if (!stopped) {
        return reply.code(404).send({ error: 'No exchange is running in this thread.' });
      }
      return reply.code(200).send({ status: 'interrupted' });
    },
  });
}

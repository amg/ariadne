import { handOver } from '@ari/lib/api/schemas/threads/handover';
import { handOverArrival } from '@services/handoverService';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { MemoryFeature } from '../../../src/types/memory';
import { type RouteOf, parsedOrNull } from '../contract';
import { userIdOf } from '../request';

/** A held handover is asked again right away; the next request holds again. */
const CAPTURE_RETRY_AFTER_SECONDS = 1;

/**
 * Starts a new chat from the thread's paused arrival: the arrival leaves
 * this thread, and the response names the fresh thread plus the arrival's
 * stored copy there, whose reply the client then asks for. 503
 * `capture_pending` while what the old thread taught is still being saved:
 * nothing moved, ask again. 409 when the message is not, or no longer, a
 * paused arrival.
 */
export function setupThreadHandoverRoute(
  fastify: FastifyInstance,
  { memory }: { memory: MemoryFeature },
) {
  fastify.route<RouteOf<typeof handOver>>({
    method: handOver.method,
    url: handOver.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const params = parsedOrNull(handOver.params, request.params);
      const body = parsedOrNull(handOver.body, request.body);
      if (!params || !body) {
        return reply.code(400).send({ error: 'Invalid thread or message id' });
      }

      const result = await handOverArrival({
        userId,
        threadId: params.id,
        messageId: body.messageId,
        memory,
      });
      if (result.type === 'error') {
        if (result.code === 'thread_not_found') {
          return reply.code(404).send({ error: 'Thread not found' });
        }
        if (result.code === 'capture_pending') {
          reply.header('Retry-After', String(CAPTURE_RETRY_AFTER_SECONDS));
          return reply.code(503).send({
            error: result.message ?? 'Memory is still being saved.',
            errorCode: result.code,
          });
        }
        return reply.code(409).send({ error: result.message ?? 'The message cannot be moved.' });
      }
      return reply.code(200).send(result.data);
    },
  });
}

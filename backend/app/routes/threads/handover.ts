import { handOverArrival } from '@services/handoverService';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';

type HandoverParams = { id: string };
type HandoverBody = { messageId?: unknown };

/**
 * Starts a new chat from the thread's paused arrival: the arrival leaves
 * this thread, and the response names the fresh thread plus the arrival's
 * stored copy there, whose reply the client then asks for. 409 when the
 * message is not, or no longer, a paused arrival.
 */
export async function setupThreadHandoverRoute(fastify: FastifyInstance) {
  fastify.post(
    '/api/threads/:id/handover',
    { preHandler: verifySession() },
    async (
      request: FastifyRequest<{ Params: HandoverParams; Body: HandoverBody }>,
      reply: FastifyReply,
    ) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const { id: threadId } = request.params;
      const messageId = request.body?.messageId;
      if (!isValidUuid(threadId) || typeof messageId !== 'string' || !isValidUuid(messageId)) {
        return reply.code(400).send({ error: 'Invalid thread or message id' });
      }

      const result = await handOverArrival({ userId, threadId, messageId });
      if (result.type === 'error') {
        if (result.code === 'thread_not_found') {
          return reply.code(404).send({ error: 'Thread not found' });
        }
        return reply.code(409).send({ error: result.message ?? 'The message cannot be moved.' });
      }
      return reply.send(result.data);
    },
  );
}

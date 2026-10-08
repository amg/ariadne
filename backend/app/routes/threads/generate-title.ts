import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { enqueueThreadGenerateTitle } from '@queue/tasks/threadGenerateTitleTask';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';

type GenerateTitleParams = {
  id: string;
};

type GenerateTitleBody = {
  /** Regenerate button on an existing thread → title from the first segment. */
  forced?: unknown;
};

/**
 * Queues the thread's titling and answers at once; the title lands with
 * the queue and reaches open tabs through the push channel. Regeneration
 * (`forced`) names the thread from its first segment and replaces any
 * title it already has. 404, with nothing queued, for a Thread the user
 * does not own.
 */
export async function setupThreadsGenerateTitleRoute(fastify: FastifyInstance) {
  fastify.post(
    '/api/threads/:id/generate-title',
    {
      // Deployment-wide cap: 5/min (shared, no auth yet).
      preHandler: verifySession(),
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const params = request.params as GenerateTitleParams;
      if (!isValidUuid(params.id)) {
        return reply.code(400).send({ error: 'Invalid thread id' });
      }
      if (!(await findThreadByIdAndUser({ userId, threadId: params.id }))) {
        return reply.code(404).send({ error: 'Thread not found' });
      }

      const body = (request.body ?? {}) as GenerateTitleBody;
      await enqueueThreadGenerateTitle({
        userId,
        threadId: params.id,
        forced: body.forced === true,
      });
      return reply.code(202).send({ success: true, queued: true });
    },
  );
}

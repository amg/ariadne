import { autoTitleThread } from '@services/titlingService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import { httpStatusFor } from '../../../src/types/errorCodes';

type GenerateTitleParams = {
  id: string;
};

type GenerateTitleBody = {
  /** Regenerate button on an existing thread → title from the first segment. */
  forced?: unknown;
};

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

      const body = (request.body ?? {}) as GenerateTitleBody;
      const outcome = await autoTitleThread(userId, params.id, body.forced === true);

      if (outcome.type === 'titled') {
        return reply.send({ success: true, title: outcome.title });
      }
      if (outcome.type === 'settled') {
        // Nothing to learn from (or provider refused).
        return reply.send({ success: true, fallback: true });
      }

      request.log.warn(
        `generate-title failed for thread ${params.id} [${outcome.code}]: ${outcome.message}`,
      );
      return reply
        .code(httpStatusFor(outcome.code))
        .send({ success: false, errorCode: outcome.code });
    },
  );
}

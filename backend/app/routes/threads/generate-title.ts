import { autoTitleThread } from '@services/titlingService';
import { DEFAULT_USER_ID } from '@services/userService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { httpStatusFor } from '../../../src/types/errorCodes';

const REQUEST_USER_ID = DEFAULT_USER_ID;

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
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as GenerateTitleParams;

      const body = (request.body ?? {}) as GenerateTitleBody;
      const outcome = await autoTitleThread(REQUEST_USER_ID, params.id, body.forced === true);

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

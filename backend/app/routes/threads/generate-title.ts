import { autoTitleThread } from '@services/titlingService';
import { DEFAULT_USER_ID } from '@services/userService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { httpStatusFor } from '../../../src/types/errorCodes';

const REQUEST_USER_ID = DEFAULT_USER_ID;

type GenerateTitleParams = {
  id: string;
};

export async function setupThreadsGenerateTitleRoute(fastify: FastifyInstance) {
  fastify.post(
    '/api/threads/:id/generate-title',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as GenerateTitleParams;

      const outcome = await autoTitleThread(REQUEST_USER_ID, params.id);

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

import { autoTitleThread } from '@services/titlingService';
import { DEFAULT_USER_ID } from '@services/userService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { httpStatusFor } from '../../../src/types/errorCodes';

const REQUEST_USER_ID = DEFAULT_USER_ID;

type GenerateTitleParams = {
  id: string;
};

type GenerateTitleBody = {
  /** Explicit "Regenerate Title" click: overwrites any existing title. */
  force?: boolean;
};

export async function setupThreadsGenerateTitleRoute(fastify: FastifyInstance) {
  fastify.post(
    '/api/threads/:id/generate-title',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as GenerateTitleParams;
      // Auto-titling posts a bare POST (no body/no content-type); force
      // regeneration sends JSON. Both shapes stay valid.
      const body = (request.body ?? {}) as GenerateTitleBody;
      const forced = body.force === true;

      const outcome = await autoTitleThread(REQUEST_USER_ID, params.id, { forced });

      if (outcome.type === 'titled') {
        return reply.send({ success: true, title: outcome.title });
      }
      if (outcome.type === 'settled') {
        // Nothing to learn from (or provider refused); the sentinel title —
        // if there was one — already landed on the static fallback.
        return reply.send({ success: true, fallback: true });
      }
      // Curated error surface: the raw provider detail (`outcome.message`,
      // e.g. DeepInfra's rejection reason) is logged here only — the client
      // receives the contract code and maps it to friendly copy itself.
      request.log.warn(
        `generate-title failed${forced ? ' (forced)' : ''} for thread ${params.id} [${outcome.code}]: ${outcome.message}`,
      );
      return reply
        .code(httpStatusFor(outcome.code))
        .send({ success: false, errorCode: outcome.code });
    },
  );
}

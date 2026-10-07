import { env } from '@config/env';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { captureUnreadTurns } from '@services/memory';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';

type CaptureMemoryParams = { id: string };

/**
 * Captures on demand everything in the thread not yet read, from each
 * segment's pointer onward — the open segment too, which the automatic
 * pass leaves until it settles. Responds with the pass report (`owed: 0`
 * means nothing new to read); 502 when a segment failed, whose pointer
 * then stays put for the next pass. 403 while thread analysis is off:
 * without segments there is nothing to capture from.
 */
export async function setupThreadCaptureMemoryRoute(fastify: FastifyInstance) {
  fastify.post(
    '/api/threads/:id/capture-memory',
    { preHandler: verifySession() },
    async (request: FastifyRequest<{ Params: CaptureMemoryParams }>, reply: FastifyReply) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const { id: threadId } = request.params;
      if (!isValidUuid(threadId)) {
        return reply.code(400).send({ error: 'Invalid thread id' });
      }
      if (!(await findThreadByIdAndUser({ userId, threadId }))) {
        return reply.code(404).send({ error: 'Thread not found' });
      }
      if (env.THREAD_ANALYSIS_MODE === 'off') {
        return reply.code(403).send({ error: 'Thread analysis is disabled' });
      }

      const report = await captureUnreadTurns({ userId, threadId });
      if (report.failed > 0) {
        request.log.warn({ threadId, report }, 'on-demand memory capture failed');
        return reply.code(502).send({
          ...report,
          error: `${report.failed} of ${report.owed} segment(s) could not be captured. Try again.`,
        });
      }
      return reply.send(report);
    },
  );
}

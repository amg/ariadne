import type { ThreadAnalysisMode } from '@ari/lib/api/schemas/threads/analysis';
import { captureThreadMemory } from '@ari/lib/api/schemas/threads/capture-memory';
import { captureUnreadTurns } from '@services/memory';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { RouteOf } from '../contract';
import { ownedThreadIdOrReject, userIdOf } from '../request';

/**
 * Captures on demand everything in the thread not yet read, from each
 * segment's pointer onward — the open segment too, which the automatic
 * pass leaves until it settles. Responds with the pass report (`owed: 0`
 * means nothing new to read); 502 when a segment failed, whose pointer
 * then stays put for the next pass. 403 while thread analysis is off:
 * without segments there is nothing to capture from.
 */
export function setupThreadCaptureMemoryRoute(
  fastify: FastifyInstance,
  { threadAnalysisMode }: { threadAnalysisMode: ThreadAnalysisMode },
) {
  fastify.route<RouteOf<typeof captureThreadMemory>>({
    method: captureThreadMemory.method,
    url: captureThreadMemory.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const threadId = await ownedThreadIdOrReject({ request, reply, userId });
      if (threadId === null) return reply;
      if (threadAnalysisMode === 'off') {
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
      return reply.code(200).send(report);
    },
  });
}

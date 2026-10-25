import {
  type ThreadAnalysisMode,
  backfillThreadAnalysis,
  threadAnalysis,
} from '@ari/lib/api/schemas/threads/analysis';
import { buildLiveAnalysisView, runLiveGate } from '@services/threadAnalysis';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { RouteOf } from '../contract';
import { ownedThreadIdOrReject, userIdOf } from '../request';

/**
 * The thread's live reading for the Analysis tab: segments + one point per
 * arrival, exactly as the live lane persisted them. Lazy backfill is
 * triggered here too — whichever surface needs the signals first fills
 * them: a thread missing verdict rows (pre-feature, a failed pipeline, a
 * fresh flag flip) catches up the moment the tab asks. Provider failures
 * during the fill never block the reading — what was already persisted is
 * returned, with `pending` marking the gap the tab renders as loading.
 */
export function setupThreadAnalysisRoute(
  fastify: FastifyInstance,
  { threadAnalysisMode }: { threadAnalysisMode: ThreadAnalysisMode },
) {
  fastify.route<RouteOf<typeof threadAnalysis>>({
    method: threadAnalysis.method,
    url: threadAnalysis.path,
    preHandler: verifySession(),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const threadId = await ownedThreadIdOrReject({ request, reply, userId });
      if (threadId === null) return reply;

      const view = await buildLiveAnalysisView({ threadId, mode: threadAnalysisMode });
      if (view.type === 'error') {
        return reply.code(502).send({ error: view.message ?? 'Failed to read the live chain.' });
      }
      return reply.code(200).send(view.data);
    },
  });

  fastify.route<RouteOf<typeof backfillThreadAnalysis>>({
    method: backfillThreadAnalysis.method,
    url: backfillThreadAnalysis.path,
    preHandler: verifySession(),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const threadId = await ownedThreadIdOrReject({ request, reply, userId });
      if (threadId === null) return reply;

      if (threadAnalysisMode === 'off') {
        return reply.code(403).send({ error: 'Thread analysis is disabled' });
      }

      // Fill missing arrival signals forward, the whole thread in one pass.
      const filled = await runLiveGate({ threadId, mode: threadAnalysisMode });
      if (filled.type === 'error') {
        request.log.warn({ code: filled.code }, 'analysis backfill failed; serving stored signals');
      }

      const view = await buildLiveAnalysisView({ threadId, mode: threadAnalysisMode });
      if (view.type === 'error') {
        return reply.code(502).send({ error: view.message ?? 'Failed to read the live chain.' });
      }
      return reply.code(200).send(view.data);
    },
  });
}

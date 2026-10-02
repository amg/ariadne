import { env } from '@config/env';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { buildLiveAnalysisView, runLiveGate } from '@services/threadAnalysis';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';

type ThreadParams = {
  id: string;
};

/**
 * The thread's live reading for the Analysis tab: segments + one point per
 * arrival, exactly as the live lane persisted them. Lazy backfill is
 * triggered here too — whichever surface needs the signals first fills
 * them: a thread missing verdict rows (pre-feature, a failed pipeline, a
 * fresh flag flip) catches up the moment the tab asks. Provider failures
 * during the fill never block the reading — what was already persisted is
 * returned, with `pending` marking the gap the tab renders as loading.
 *
 * Bounded backfill: at most 20 arrivals filled per request — leftovers
 * catch up on the next read; the live lane during exchanges is exempt
 * (bounded by the chat cap itself).
 */
const ANALYSIS_BACKFILL_LIMIT = 20;

export async function setupThreadAnalysisRoute(fastify: FastifyInstance) {
  fastify.get(
    '/api/threads/:id/analysis',
    {
      // Deployment-wide cap: 10/min (shared, no auth yet).
      preHandler: verifySession(),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest<{ Params: ThreadParams }>, reply: FastifyReply) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const { id: threadId } = request.params;
      if (!isValidUuid(threadId)) {
        return reply.code(400).send({ error: 'Invalid thread id' });
      }

      const thread = await findThreadByIdAndUser({ userId: userId, threadId });
      if (!thread) {
        // Unknown thread and foreign thread stay indistinguishable.
        return reply.code(404).send({ error: 'Thread not found' });
      }

      const view = await buildLiveAnalysisView(threadId);
      if (view.type === 'error') {
        return reply.code(502).send({ error: view.message ?? 'Failed to read the live chain.' });
      }
      return reply.send(view.data);
    },
  );

  fastify.post(
    '/api/threads/:id/analysis/backfill',
    {
      // Throttling for backfill (handled by T-RL-02, placeholder limit here)
      preHandler: verifySession(),
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest<{ Params: ThreadParams }>, reply: FastifyReply) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const { id: threadId } = request.params;
      if (!isValidUuid(threadId)) {
        return reply.code(400).send({ error: 'Invalid thread id' });
      }

      const thread = await findThreadByIdAndUser({ userId: userId, threadId });
      if (!thread) {
        return reply.code(404).send({ error: 'Thread not found' });
      }

      if (env.THREAD_ANALYSIS_MODE === 'off') {
        return reply.code(403).send({ error: 'Thread analysis is disabled' });
      }

      // Fill missing arrival signals forward, bounded to 20 per request.
      const filled = await runLiveGate({ threadId, limit: ANALYSIS_BACKFILL_LIMIT });
      if (filled.type === 'error') {
        request.log.warn({ code: filled.code }, 'analysis backfill failed; serving stored signals');
      }

      const view = await buildLiveAnalysisView(threadId);
      if (view.type === 'error') {
        return reply.code(502).send({ error: view.message ?? 'Failed to read the live chain.' });
      }
      return reply.send(view.data);
    },
  );
}

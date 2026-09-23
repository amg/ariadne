import { env } from '@config/env';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { buildLiveAnalysisView, runLiveGate } from '@services/threadAnalysis';
import { DEFAULT_USER_ID } from '@services/userService';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Placeholder until page-level auth resolves the user.
const REQUEST_USER_ID = DEFAULT_USER_ID;

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
 */
export async function setupThreadAnalysisRoute(fastify: FastifyInstance) {
  fastify.get(
    '/api/threads/:id/analysis',
    async (request: FastifyRequest<{ Params: ThreadParams }>, reply: FastifyReply) => {
      const { id: threadId } = request.params;
      if (!isValidUuid(threadId)) {
        return reply.code(400).send({ error: 'Invalid thread id' });
      }

      const thread = await findThreadByIdAndUser({ userId: REQUEST_USER_ID, threadId });
      if (!thread) {
        // Unknown thread and foreign thread stay indistinguishable.
        return reply.code(404).send({ error: 'Thread not found' });
      }

      if (env.THREAD_ANALYSIS_MODE === 'off') {
        const view = await buildLiveAnalysisView(threadId);
        if (view.type === 'error') return reply.code(502).send({ error: view.message });
        return reply.send(view.data);
      }

      // Fill missing arrival signals forward (skip everything persisted).
      const filled = await runLiveGate({ threadId });
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

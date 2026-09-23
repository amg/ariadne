import { env } from '@config/env';
import type { FastifyInstance } from 'fastify';

/**
 * Deployment surfaces the frontend drives its chrome from. Today: the
 * thread-analysis feature flag only — `off` hides the Analysis tab and
 * the advisory bubble signal; the stored signals themselves survive the
 * off period.
 */
export async function setupConfigRoute(fastify: FastifyInstance) {
  fastify.get('/api/config', async (_request, reply) => {
    return reply.send({
      threadAnalysisMode: env.THREAD_ANALYSIS_MODE,
    });
  });
}

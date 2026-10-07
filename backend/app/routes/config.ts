import { env } from '@config/env';
import type { FeatureFlags } from '@config/features';
import type { FastifyInstance } from 'fastify';

/**
 * Deployment surfaces the frontend drives its chrome from: the
 * thread-analysis mode (`off` hides the Analysis tab and the advisory
 * bubble signal; the stored signals survive the off period) and which
 * features this deployment runs.
 */
export async function setupConfigRoute(fastify: FastifyInstance, features: FeatureFlags) {
  fastify.get('/api/config', async (_request, reply) => {
    return reply.send({
      threadAnalysisMode: env.THREAD_ANALYSIS_MODE,
      features,
    });
  });
}

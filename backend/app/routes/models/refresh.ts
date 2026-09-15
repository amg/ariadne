import { getTimeUntilNextRefresh, refreshModelConfigs } from '@services/modelConfigService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export async function setupModelsRefreshRoute(fastify: FastifyInstance) {
  fastify.post('/api/models/refresh', async (_request: FastifyRequest, reply: FastifyReply) => {
    // The service enforces the shared DB cooldown (stateless across
    // servers/users); the route only shapes the 429 response.
    const result = await refreshModelConfigs();
    if (!result.success) {
      if (result.rateLimited) {
        const waitTime = await getTimeUntilNextRefresh();
        return reply.code(429).send({
          error: 'Rate limited',
          message: `Please wait ${Math.ceil(waitTime / 1000)} seconds before refreshing again.`,
          modelsUpdated: 0,
          rateLimited: true,
          retryAfter: Math.ceil(waitTime / 1000),
        });
      }
      return reply.code(500).send({
        error: result.error ?? 'Failed to refresh model configs',
        modelsUpdated: 0,
        rateLimited: false,
      });
    }
    return reply.send({
      success: true,
      modelsUpdated: result.modelsUpdated,
    });
  });
}

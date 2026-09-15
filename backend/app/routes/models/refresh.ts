import {
  canRefreshModels,
  getTimeUntilNextRefresh,
  refreshModelConfigs,
} from '@services/modelConfigService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export async function setupModelsRefreshRoute(fastify: FastifyInstance) {
  fastify.post('/api/models/refresh', async (_request: FastifyRequest, reply: FastifyReply) => {
    // Quick check before calling service
    if (!canRefreshModels()) {
      const waitTime = getTimeUntilNextRefresh();
      return reply.code(429).send({
        error: 'Rate limited',
        message: `Please wait ${Math.ceil(waitTime / 1000)} seconds before refreshing again.`,
        modelsUpdated: 0,
        rateLimited: true,
        retryAfter: Math.ceil(waitTime / 1000),
      });
    }

    const result = await refreshModelConfigs();
    if (!result.success) {
      const statusCode = result.rateLimited ? 429 : 500;
      return reply.code(statusCode).send({
        error: result.error ?? 'Failed to refresh model configs',
        modelsUpdated: 0,
        rateLimited: result.rateLimited,
      });
    }
    return reply.send({
      success: true,
      modelsUpdated: result.modelsUpdated,
    });
  });
}

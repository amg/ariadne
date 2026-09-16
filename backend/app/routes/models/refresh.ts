import { getTimeUntilNextRefresh, refreshModelConfigs } from '@services/modelConfigService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export async function setupModelsRefreshRoute(fastify: FastifyInstance) {
  fastify.post('/api/models/refresh', async (_request: FastifyRequest, reply: FastifyReply) => {
    // The service enforces the shared DB cooldown (stateless across
    // servers/users); the route only shapes the 429 response.
    const result = await refreshModelConfigs();
    if (result.rateLimited) {
      return reply.send({
        success: true,
        modelsUpdated: 0,
        rateLimited: true,
      });
    }
    if (!result.success) {
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

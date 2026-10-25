import { refreshModels } from '@ari/lib/api/schemas/models/models';
import { refreshModelConfigs } from '@services/modelConfigService';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { RouteOf } from '../contract';

export function setupModelsRefreshRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof refreshModels>>({
    method: refreshModels.method,
    url: refreshModels.path,
    preHandler: verifySession(),
    config: { rateLimit: { max: 2, timeWindow: '1 minute' } },
    handler: async (_request, reply) => {
      // The service enforces the shared DB cooldown (stateless across
      // servers/users); the route only shapes the response.
      const result = await refreshModelConfigs();
      if (result.rateLimited) {
        return reply.code(200).send({ success: true, modelsUpdated: 0, rateLimited: true });
      }
      if (!result.success) {
        return reply.code(500).send({
          error: result.error ?? 'Failed to refresh model configs',
          modelsUpdated: 0,
          rateLimited: false,
        });
      }
      return reply.code(200).send({ success: true, modelsUpdated: result.modelsUpdated });
    },
  });
}

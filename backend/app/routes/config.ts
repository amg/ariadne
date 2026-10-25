import { getConfig } from '@ari/lib/api/schemas/config/config';
import type { FastifyInstance } from 'fastify';
import type { FeatureFlags } from '../types';
import type { RouteOf } from './contract';

/**
 * Deployment surfaces the frontend drives its chrome from: the
 * thread-analysis mode (`off` hides the Analysis tab and the advisory
 * bubble signal; the stored signals survive the off period) and which
 * features this deployment runs.
 */
export function setupConfigRoute(
  fastify: FastifyInstance,
  { memory, threadAnalysisMode }: FeatureFlags,
) {
  fastify.route<RouteOf<typeof getConfig>>({
    method: getConfig.method,
    url: getConfig.path,
    handler: async (_request, reply) =>
      reply.code(200).send({ threadAnalysisMode, features: { memory } }),
  });
}

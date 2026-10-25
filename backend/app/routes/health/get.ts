import { health } from '@ari/lib/api/schemas/health/health';
import type { FastifyInstance } from 'fastify';
import type { RouteOf } from '../contract';

export function setupHealthRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof health>>({
    method: health.method,
    url: health.path,
    handler: async (_request, reply) =>
      reply.code(200).send({ status: 'ok', message: 'Chatbot API is running' }),
  });
}

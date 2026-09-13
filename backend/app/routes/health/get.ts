import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export async function setupHealthRoute(fastify: FastifyInstance) {
  fastify.get('/api/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ status: 'ok', message: 'Chatbot API is running' });
  });
}

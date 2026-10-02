import { ThreadValidationError, createThread } from '@services/threadService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';

export async function setupThreadsPostRoute(fastify: FastifyInstance) {
  fastify.post(
    '/api/threads',
    { preHandler: verifySession() },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const userId = (_request as SessionRequest).session?.getUserId() as string;
      try {
        const thread = await createThread({ userId: userId });
        return reply.send(thread);
      } catch (err) {
        if (err instanceof ThreadValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}

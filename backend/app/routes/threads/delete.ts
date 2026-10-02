import { deleteThread } from '@services/threadService';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';

type ThreadParams = {
  id: string;
};

export async function setupThreadsDeleteRoute(fastify: FastifyInstance) {
  fastify.delete(
    '/api/threads/:id',
    { preHandler: verifySession() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const { id } = request.params as ThreadParams;

      if (!isValidUuid(id)) {
        return reply.code(400).send({ error: 'Invalid thread id' });
      }

      const deleted = await deleteThread({ userId: userId, threadId: id });
      if (!deleted) {
        return reply.code(404).send({ error: 'Thread not found' });
      }
      return reply.code(204).send();
    },
  );
}

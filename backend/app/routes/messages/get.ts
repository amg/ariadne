import { getMessages } from '@services/messageService';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';

type ThreadParams = {
  id: string;
};

export async function setupMessagesGetRoute(fastify: FastifyInstance) {
  fastify.get(
    '/api/threads/:id/messages',
    { preHandler: verifySession() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const params = request.params as ThreadParams;
      if (!isValidUuid(params.id)) {
        return reply.code(400).send({ error: 'Invalid thread id' });
      }
      const messages = await getMessages({ userId: userId, threadId: params.id });
      if (!messages) {
        // Unknown thread and foreign thread are intentionally indistinguishable.
        return reply.code(404).send({ error: 'Thread not found' });
      }
      return reply.send(messages);
    },
  );
}

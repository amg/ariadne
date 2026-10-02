import { ThreadValidationError, renameThread } from '@services/threadService';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';

type ThreadParams = {
  id: string;
};

type RenameBody = {
  title?: unknown;
};

export async function setupThreadsPatchRoute(fastify: FastifyInstance) {
  fastify.patch(
    '/api/threads/:id',
    { preHandler: verifySession() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const { id } = request.params as ThreadParams;
      const body = (request.body ?? {}) as RenameBody;

      if (!isValidUuid(id)) {
        return reply.code(400).send({ error: 'Invalid thread id' });
      }
      if (typeof body.title !== 'string') {
        return reply.code(400).send({ error: 'title must be a string' });
      }

      try {
        const thread = await renameThread({
          userId: userId,
          threadId: id,
          title: body.title,
        });
        if (!thread) {
          return reply.code(404).send({ error: 'Thread not found' });
        }
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

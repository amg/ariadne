import { ThreadValidationError, renameThread } from '@services/threadService';
import { DEFAULT_USER_ID } from '@services/userService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Placeholder until page-level auth resolves the user.
const REQUEST_USER_ID = DEFAULT_USER_ID;

type ThreadParams = {
  id: string;
};

type RenameBody = {
  title?: unknown;
};

export async function setupThreadsPatchRoute(fastify: FastifyInstance) {
  fastify.patch('/api/threads/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as ThreadParams;
    const body = (request.body ?? {}) as RenameBody;

    if (typeof body.title !== 'string') {
      return reply.code(400).send({ error: 'title must be a string' });
    }

    try {
      const thread = await renameThread({
        userId: REQUEST_USER_ID,
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
  });
}

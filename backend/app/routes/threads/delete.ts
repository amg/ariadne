import { deleteThread } from '@services/threadService';
import { DEFAULT_USER_ID } from '@services/userService';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Placeholder until page-level auth resolves the user.
const REQUEST_USER_ID = DEFAULT_USER_ID;

type ThreadParams = {
  id: string;
};

export async function setupThreadsDeleteRoute(fastify: FastifyInstance) {
  fastify.delete('/api/threads/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as ThreadParams;

    if (!isValidUuid(id)) {
      return reply.code(400).send({ error: 'Invalid thread id' });
    }

    const deleted = await deleteThread({ userId: REQUEST_USER_ID, threadId: id });
    if (!deleted) {
      return reply.code(404).send({ error: 'Thread not found' });
    }
    return reply.code(204).send();
  });
}

import { getThreadSummary } from '@services/threadSummaryService';
import { DEFAULT_USER_ID } from '@services/userService';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Placeholder until page-level auth resolves the user.
const REQUEST_USER_ID = DEFAULT_USER_ID;

type ThreadParams = {
  id: string;
};

export async function setupThreadSummaryRoute(fastify: FastifyInstance) {
  fastify.get('/api/threads/:id/summary', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as ThreadParams;
    if (!isValidUuid(params.id)) {
      return reply.code(400).send({ error: 'Invalid thread id' });
    }
    const summary = await getThreadSummary({ userId: REQUEST_USER_ID, threadId: params.id });
    if (!summary) {
      return reply.code(404).send({ error: 'Thread not found' });
    }
    return reply.send(summary);
  });
}

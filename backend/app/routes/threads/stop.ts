import { stopThreadExchange } from '@services/aiService';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type StopParams = {
  id: string;
};

/**
 * User stop for the thread's live exchange: aborts the provider stream,
 * which settles the exchange as `interrupted` (partial text + estimated
 * spend persist). The connection-close path does the same for a vanished
 * client; this endpoint makes the stop explicit and callable — 200 except
 * 404 when nothing is running.
 */
export async function setupThreadStopRoute(fastify: FastifyInstance) {
  fastify.post('/api/threads/:id/stop', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: threadId } = request.params as StopParams;
    if (!isValidUuid(threadId)) {
      return reply.code(400).send({ error: 'Invalid thread id' });
    }
    const stopped = stopThreadExchange(threadId);
    if (!stopped) {
      return reply.code(404).send({ error: 'No exchange is running in this thread.' });
    }
    return reply.code(200).send({ status: 'interrupted' });
  });
}

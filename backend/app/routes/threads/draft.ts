import { findResumeDraft } from '@queries/messages/findResumeDraft';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { DEFAULT_USER_ID } from '@services/userService';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Placeholder until page-level auth resolves the user.
const REQUEST_USER_ID = DEFAULT_USER_ID;

type DraftParams = {
  id: string;
};

/**
 * The resume draft of a thread: when its newest exchange was abandoned
 * (interrupted or failed) and never completed, its arrival text comes back
 * for the input to prefill — 204 when nothing is owed.
 */
export async function setupThreadDraftRoute(fastify: FastifyInstance) {
  fastify.get('/api/threads/:id/draft', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id: threadId } = request.params as DraftParams;
    if (!isValidUuid(threadId)) {
      return reply.code(400).send({ error: 'Invalid thread id' });
    }
    const thread = await findThreadByIdAndUser({ userId: REQUEST_USER_ID, threadId });
    if (!thread) {
      return reply.code(404).send({ error: 'Thread not found' });
    }
    const draft = await findResumeDraft({ threadId });
    if (!draft) {
      return reply.code(204).send();
    }
    return reply.send({ messageId: draft.messageId, text: draft.content });
  });
}

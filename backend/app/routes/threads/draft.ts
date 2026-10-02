import { findResumeDraft } from '@queries/messages/findResumeDraft';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';

type DraftParams = {
  id: string;
};

/**
 * The resume draft of a thread: when its newest exchange was abandoned
 * (interrupted or failed) and never completed, its arrival text comes back
 * for the input to prefill — 204 when nothing is owed.
 */
export async function setupThreadDraftRoute(fastify: FastifyInstance) {
  fastify.get(
    '/api/threads/:id/draft',
    { preHandler: verifySession() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const { id: threadId } = request.params as DraftParams;
      if (!isValidUuid(threadId)) {
        return reply.code(400).send({ error: 'Invalid thread id' });
      }
      const thread = await findThreadByIdAndUser({ userId: userId, threadId });
      if (!thread) {
        return reply.code(404).send({ error: 'Thread not found' });
      }
      const draft = await findResumeDraft({ threadId });
      if (!draft) {
        return reply.code(204).send();
      }
      return reply.send({ messageId: draft.messageId, text: draft.content });
    },
  );
}

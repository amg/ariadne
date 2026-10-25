import { threadDraft } from '@ari/lib/api/schemas/threads/draft';
import { findResumeDraft } from '@queries/messages/findResumeDraft';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { RouteOf } from '../contract';
import { ownedThreadIdOrReject, userIdOf } from '../request';

/**
 * The resume draft of a thread: the text of its newest user Message when
 * that Message is abandoned and no Exchange completed after it, for the
 * input to prefill. 204 when nothing is owed.
 */
export function setupThreadDraftRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof threadDraft>>({
    method: threadDraft.method,
    url: threadDraft.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const threadId = await ownedThreadIdOrReject({ request, reply, userId });
      if (threadId === null) return reply;
      const draft = await findResumeDraft({ threadId });
      if (!draft) return reply.code(204).send();
      return reply.code(200).send({ messageId: draft.messageId, text: draft.content });
    },
  });
}

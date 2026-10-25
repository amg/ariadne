import { listMessages } from '@ari/lib/api/schemas/messages/list';
import type { ThreadAnalysisMode } from '@ari/lib/api/schemas/threads/analysis';
import { getMessages } from '@services/messageService';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { RouteOf } from '../contract';
import { threadIdOrReject, userIdOf } from '../request';

export function setupMessagesGetRoute(
  fastify: FastifyInstance,
  { threadAnalysisMode }: { threadAnalysisMode: ThreadAnalysisMode },
) {
  fastify.route<RouteOf<typeof listMessages>>({
    method: listMessages.method,
    url: listMessages.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const threadId = threadIdOrReject({ request, reply });
      if (threadId === null) return reply;
      const messages = await getMessages({ userId, threadId, threadAnalysisMode });
      // Unknown thread and foreign thread are intentionally indistinguishable.
      if (!messages) return reply.code(404).send({ error: 'Thread not found' });
      return reply.code(200).send(messages);
    },
  });
}

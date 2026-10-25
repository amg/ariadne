import { editMessage as editMessageEndpoint } from '@ari/lib/api/schemas/messages/edit';
import { enqueueDriftGateJudgeArrival } from '@queue/tasks/driftGateJudgeArrivalTask';
import { editMessage } from '@services/messageService';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { ResultError } from '../../../src/types/result';
import { type RouteOf, parsedOrNull } from '../contract';
import { userIdOf } from '../request';

/** The status and body an edit failure answers with. */
function updateError(error: ResultError): { status: 400 | 404 | 409 | 500; error: string } {
  // Unknown thread, foreign thread and foreign message stay indistinguishable.
  if (error.code === 'thread_not_found') return { status: 404, error: 'Message not found' };
  if (error.code === 'not_last')
    return { status: 409, error: error.message ?? 'Only the last message can be edited.' };
  if (error.code === 'invalid_content')
    return { status: 400, error: error.message ?? 'Invalid content.' };
  return { status: 500, error: 'Failed to update the message.' };
}

/**
 * Edits the thread's last user message — a fork: the old arrival is
 * abandoned (text and arrival spend stay) and the edited text lands as a
 * new user row, judged by the Drift gate in the background. Empty
 * strings are rejected up front so an edit can never blank a bubble
 * out — retry (chat regenerate) is the recovery path for replies, not
 * deletion.
 */
export function setupMessagesPatchRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof editMessageEndpoint>>({
    method: editMessageEndpoint.method,
    url: editMessageEndpoint.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const params = parsedOrNull(editMessageEndpoint.params, request.params);
      if (!params) return reply.code(400).send({ error: 'Invalid thread or message id' });
      const body = parsedOrNull(editMessageEndpoint.body, request.body);
      if (!body) return reply.code(400).send({ error: 'content must be a non-empty string' });

      const result = await editMessage({
        userId,
        threadId: params.id,
        messageId: params.messageId,
        content: body.content,
        judging: { enqueueDriftGateJudgeArrival },
      });
      if (result.type === 'error') {
        const { status, error } = updateError(result);
        return reply.code(status).send({ error });
      }
      return reply.code(200).send(result.data);
    },
  });
}

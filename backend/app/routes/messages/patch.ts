import { editMessage } from '@services/messageService';
import { DEFAULT_USER_ID } from '@services/userService';
import { isValidUuid } from '@services/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Result } from '../../../src/types/result';

// Placeholder until page-level auth resolves the user.
const REQUEST_USER_ID = DEFAULT_USER_ID;

type Params = {
  id: string;
  messageId: string;
};

type PatchBody = {
  content?: unknown;
};

/** Maps edit failures to responses; keeps the handler shallow. */
function sendUpdateError(reply: FastifyReply, error: Extract<Result<never>, { type: 'error' }>) {
  // Unknown thread, foreign thread and foreign message stay indistinguishable.
  if (error.code === 'thread_not_found')
    return reply.code(404).send({ error: 'Message not found' });
  if (error.code === 'not_last') return reply.code(409).send({ error: error.message });
  if (error.code === 'invalid_content') return reply.code(400).send({ error: error.message });
  return reply.code(500).send({ error: 'Failed to update the message.' });
}

/**
 * Edits the thread's last user message — a fork: the old arrival is
 * abandoned (text and arrival spend stay) and the edited text lands as a
 * new user row. Empty strings are rejected up front so an edit can never
 * blank a bubble out — retry (chat regenerate) is the recovery path for
 * replies, not deletion.
 */
export async function setupMessagesPatchRoute(fastify: FastifyInstance) {
  fastify.patch(
    '/api/threads/:id/messages/:messageId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, messageId } = request.params as Params;
      if (!isValidUuid(id) || !isValidUuid(messageId)) {
        return reply.code(400).send({ error: 'Invalid thread or message id' });
      }

      const body = (request.body ?? {}) as PatchBody;
      if (typeof body.content !== 'string' || body.content.trim().length === 0) {
        return reply.code(400).send({ error: 'content must be a non-empty string' });
      }

      const result = await editMessage({
        userId: REQUEST_USER_ID,
        threadId: id,
        messageId,
        content: body.content,
      });
      if (result.type === 'error') return sendUpdateError(reply, result);
      return reply.send(result.data);
    },
  );
}

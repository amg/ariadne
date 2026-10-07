import { deleteUserFact } from '@queries/userFacts/deleteUserFact';
import { listAllUserFacts } from '@queries/userFacts/listAllUserFacts';
import { updateUserFact } from '@queries/userFacts/updateUserFact';
import { editFactContent } from '@services/memory';
import {
  getUserSettings,
  updateUserSettings,
  validatedSettingsPatch,
} from '@services/settingsService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';

/** The signed-in user's settings, with every default resolved. */
export async function setupSettingsGetRoute(fastify: FastifyInstance) {
  fastify.get(
    '/api/settings',
    { preHandler: verifySession() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      return reply.send(await getUserSettings({ userId }));
    },
  );
}

/** Applies a partial update; 400 on unknown keys or invalid values. */
export async function setupSettingsPatchRoute(fastify: FastifyInstance) {
  fastify.patch(
    '/api/settings',
    { preHandler: verifySession() },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const patch = validatedSettingsPatch(request.body);
      if (patch.type === 'error') {
        return reply.code(400).send({ error: patch.message ?? 'Invalid settings' });
      }
      return reply.send(await updateUserSettings({ userId, patch: patch.data }));
    },
  );
}

/** Lists all the user's Facts (including suppressed), newest first. */
export async function setupMemoryFactsGetRoute(fastify: FastifyInstance) {
  fastify.get(
    '/api/memory/facts',
    { preHandler: verifySession() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      return reply.send(await listAllUserFacts({ userId }));
    },
  );
}

async function handleSuppressionToggle(
  factId: string,
  userId: string,
  suppressed: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  if (typeof suppressed !== 'boolean') {
    return { statusCode: 400, body: { error: 'suppressed must be a boolean' } };
  }
  try {
    const updated = await updateUserFact({ factId, userId, suppressed });
    return { statusCode: 200, body: updated };
  } catch {
    return { statusCode: 404, body: { error: 'Fact not found' } };
  }
}

async function handleContentEdit(
  factId: string,
  userId: string,
  content: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  if (typeof content !== 'string' || content.trim() === '') {
    return { statusCode: 400, body: { error: 'content must be a non-empty string' } };
  }
  const edited = await editFactContent({ factId, userId, newContent: content });
  if (edited.type === 'success') return { statusCode: 200, body: edited.data };
  if (edited.code === 'fact_not_found') {
    return { statusCode: 404, body: { error: 'Fact not found' } };
  }
  console.error('Failed to edit fact:', edited.code, edited.message);
  return {
    statusCode: 502,
    body: { error: 'Could not re-evaluate the edited fact; it was left unchanged. Try again.' },
  };
}

/**
 * Updates a Fact: either edits content (invalidates old, inserts new) or
 * toggles suppression. 404 when not found; 400 on invalid payload; 502
 * when an edit cannot be re-evaluated (the Fact stays unchanged).
 */
export async function setupMemoryFactsPatchRoute(fastify: FastifyInstance) {
  fastify.patch(
    '/api/memory/facts/:id',
    { preHandler: verifySession() },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
      reply: FastifyReply,
    ) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const factId = request.params.id;
      const body = request.body as Record<string, unknown> | undefined;

      if (!body || typeof body !== 'object') {
        return reply.code(400).send({ error: 'Invalid request body' });
      }

      if ('suppressed' in body) {
        const result = await handleSuppressionToggle(factId, userId, body.suppressed);
        return reply.code(result.statusCode).send(result.body);
      }

      if ('content' in body) {
        const result = await handleContentEdit(factId, userId, body.content);
        return reply.code(result.statusCode).send(result.body);
      }

      return reply.code(400).send({ error: 'Must provide either content or suppressed' });
    },
  );
}

/** Hard-deletes a Fact. 404 when not found. */
export async function setupMemoryFactsDeleteRoute(fastify: FastifyInstance) {
  fastify.delete(
    '/api/memory/facts/:id',
    { preHandler: verifySession() },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;
      const factId = request.params.id;
      try {
        await deleteUserFact({ factId, userId });
        return reply.code(204).send();
      } catch {
        return reply.code(404).send({ error: 'Fact not found' });
      }
    },
  );
}

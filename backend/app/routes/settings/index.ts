import { deleteFact, listFacts, updateFact } from '@ari/lib/api/schemas/settings/facts';
import { getSettings, updateSettings } from '@ari/lib/api/schemas/settings/settings';
import { deleteUserFact } from '@queries/userFacts/deleteUserFact';
import { listAllUserFacts } from '@queries/userFacts/listAllUserFacts';
import { updateUserFact } from '@queries/userFacts/updateUserFact';
import { editFactContent } from '@services/memory';
import { getUserSettings, updateUserSettings } from '@services/settingsService';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { NoResultError } from 'kysely';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import { type RouteOf, parsedOrNull } from '../contract';
import { userIdOf } from '../request';

/** The signed-in user's settings, with every default resolved. */
export function setupSettingsGetRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof getSettings>>({
    method: getSettings.method,
    url: getSettings.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      return reply.code(200).send(await getUserSettings({ userId }));
    },
  });
}

/** Applies a partial update. Keys that are not settings are dropped; 400 on invalid values. */
export function setupSettingsPatchRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof updateSettings>>({
    method: updateSettings.method,
    url: updateSettings.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const patch = parsedOrNull(updateSettings.body, request.body);
      if (!patch) return reply.code(400).send({ error: 'Invalid settings' });
      return reply.code(200).send(await updateUserSettings({ userId, patch }));
    },
  });
}

/** Lists all the user's Facts (including suppressed), newest first. */
export function setupMemoryFactsGetRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof listFacts>>({
    method: listFacts.method,
    url: listFacts.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      return reply.code(200).send(await listAllUserFacts({ userId }));
    },
  });
}

type FactReply = FastifyReply<RouteOf<typeof updateFact>>;

async function toggleSuppression(
  reply: FactReply,
  factId: string,
  userId: string,
  suppressed: boolean,
) {
  try {
    return reply.code(200).send(await updateUserFact({ factId, userId, suppressed }));
  } catch (error) {
    if (error instanceof NoResultError) return reply.code(404).send({ error: 'Fact not found' });
    throw error;
  }
}

async function editContent(reply: FactReply, factId: string, userId: string, content: string) {
  const edited = await editFactContent({ factId, userId, newContent: content });
  if (edited.type === 'success') return reply.code(200).send(edited.data);
  if (edited.code === 'fact_not_found') return reply.code(404).send({ error: 'Fact not found' });
  console.error('Failed to edit fact:', edited.code, edited.message);
  return reply.code(502).send({
    error: 'Could not re-evaluate the edited fact; it was left unchanged. Try again.',
  });
}

/**
 * Updates a Fact: either edits content (invalidates old, inserts new) or
 * toggles suppression. 404 when not found, or when an edit's Fact was
 * superseded meanwhile; 400 on a malformed id or invalid payload; 502
 * when an edit cannot be re-evaluated (the Fact stays unchanged).
 */
export function setupMemoryFactsPatchRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof updateFact>>({
    method: updateFact.method,
    url: updateFact.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const params = parsedOrNull(updateFact.params, request.params);
      if (!params) return reply.code(400).send({ error: 'Invalid fact id' });
      const body = parsedOrNull(updateFact.body, request.body);
      if (!body) {
        return reply.code(400).send({
          error: 'Provide either suppressed as a boolean or content as non-empty text',
        });
      }
      if ('suppressed' in body) return toggleSuppression(reply, params.id, userId, body.suppressed);
      return editContent(reply, params.id, userId, body.content);
    },
  });
}

/** Hard-deletes a Fact. 404 when not found; 400 on a malformed id. */
export function setupMemoryFactsDeleteRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof deleteFact>>({
    method: deleteFact.method,
    url: deleteFact.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);
      const params = parsedOrNull(deleteFact.params, request.params);
      if (!params) return reply.code(400).send({ error: 'Invalid fact id' });
      if (!(await deleteUserFact({ factId: params.id, userId }))) {
        return reply.code(404).send({ error: 'Fact not found' });
      }
      return reply.code(204).send();
    },
  });
}

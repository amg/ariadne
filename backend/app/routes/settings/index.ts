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

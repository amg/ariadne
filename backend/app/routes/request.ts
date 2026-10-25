import { threadParams } from '@ari/lib/api/schemas/common/threadParams';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { parsedOrNull } from './contract';

/**
 * The signed-in user of a request. Only a route behind `verifySession()`
 * has one; asking for it anywhere else is a mistake in the route, so it
 * throws.
 */
export function userIdOf(request: FastifyRequest) {
  // Cast: `verifySession()` adds the session to the request, and Fastify's own type does not know it.
  const { session } = request as SessionRequest;
  if (!session) throw new Error('The route reads the signed-in user without verifySession()');
  return session.getUserId();
}

/**
 * The Thread id in the route parameters. A malformed one is answered with
 * 400 here and gives null, so the handler only has to stop.
 */
export function threadIdOrReject({
  request,
  reply,
}: {
  request: FastifyRequest;
  reply: FastifyReply;
}) {
  const params = parsedOrNull(threadParams, request.params);
  if (params) return params.id;
  reply.code(400).send({ error: 'Invalid thread id' });
  return null;
}

/**
 * The Thread id in the route parameters, once the user is known to own that
 * Thread. A malformed id is answered with 400 and an unknown or foreign
 * Thread with 404, each giving null, so the handler only has to stop.
 */
export async function ownedThreadIdOrReject({
  request,
  reply,
  userId,
}: {
  request: FastifyRequest;
  reply: FastifyReply;
  userId: string;
}) {
  const threadId = threadIdOrReject({ request, reply });
  if (threadId === null) return null;
  if (await findThreadByIdAndUser({ userId, threadId })) return threadId;
  reply.code(404).send({ error: 'Thread not found' });
  return null;
}

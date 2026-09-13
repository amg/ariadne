import { db } from '@db/db';
import { getThreads } from '@services/threadService';
import { DEFAULT_USER_ID } from '@services/userService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Placeholder until page-level auth resolves the user; the route layer is the
// only place allowed to assume it.
const REQUEST_USER_ID = DEFAULT_USER_ID;

export async function setupThreadsGetRoute(fastify: FastifyInstance) {
  fastify.get('/api/threads', async (_request: FastifyRequest, reply: FastifyReply) => {
    const threads = await getThreads(db, REQUEST_USER_ID);
    return reply.send(threads);
  });
}

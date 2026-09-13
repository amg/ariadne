import { db } from '@db/db';
import { createThread } from '@services/threadService';
import { DEFAULT_USER_ID } from '@services/userService';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Placeholder until page-level auth resolves the user.
const REQUEST_USER_ID = DEFAULT_USER_ID;

type CreateThreadBody = {
  title?: string;
};

export async function setupThreadsPostRoute(fastify: FastifyInstance) {
  fastify.post('/api/threads', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CreateThreadBody;
    const thread = await createThread(db, REQUEST_USER_ID, body.title);
    return reply.send(thread);
  });
}

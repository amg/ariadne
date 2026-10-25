import { randomUUID } from 'node:crypto';
import { findJobByKey } from '@queries/queue/findJobByKey';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { THREAD_GENERATE_TITLE } from '@queue/tasks/threadGenerateTitleTask';
import { useTestDb } from '@test/test-db';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupThreadsGenerateTitleRoute } from './generate-title';

/** The session service is out of process; each request names its user in a header instead. */
vi.mock('supertokens-node/recipe/session/framework/fastify', () => ({
  verifySession:
    () =>
    async (request: { headers: Record<string, unknown>; session?: unknown }): Promise<void> => {
      const userId = String(request.headers['x-test-user']);
      request.session = { getUserId: () => userId };
    },
}));

useTestDb();

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  setupThreadsGenerateTitleRoute(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function freshUser(): Promise<string> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  return userId;
}

function generateTitle(userId: string, threadId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/threads/${threadId}/generate-title`,
    headers: { 'x-test-user': userId },
  });
}

async function titlingQueuedFor(threadId: string) {
  return (await findJobByKey({ task: THREAD_GENERATE_TITLE, key: threadId })) !== null;
}

describe('POST /api/threads/:id/generate-title', () => {
  it('queues titling for a Thread the user owns', async () => {
    const userId = await freshUser();
    const { id: threadId } = await insertThread({ userId });

    const response = await generateTitle(userId, threadId);

    expect(response.statusCode).toBe(202);
    expect(await titlingQueuedFor(threadId)).toBe(true);
  });

  it('answers 400 for a malformed Thread id', async () => {
    const userId = await freshUser();

    const response = await generateTitle(userId, 'not-a-uuid');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Invalid thread id' });
  });

  it('answers 404 and queues nothing for an unknown Thread', async () => {
    const userId = await freshUser();
    const threadId = randomUUID();

    const response = await generateTitle(userId, threadId);

    expect(response.statusCode).toBe(404);
    expect(await titlingQueuedFor(threadId)).toBe(false);
  });

  it('answers 404 and queues nothing for another user\u2019s Thread', async () => {
    const owner = await freshUser();
    const stranger = await freshUser();
    const { id: threadId } = await insertThread({ userId: owner });

    const response = await generateTitle(stranger, threadId);

    expect(response.statusCode).toBe(404);
    expect(await titlingQueuedFor(threadId)).toBe(false);
  });
});

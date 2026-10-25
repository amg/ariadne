import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { db } from '@db/db';
import { insertUserFact } from '@queries/userFacts/insertUserFact';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { useTestDb } from '@test/test-db';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type MockInferenceServer,
  buildMockEmbedding,
  startMockInferenceServer,
} from '../../../mock/inferenceServer';
import { setupMemoryFactsDeleteRoute, setupMemoryFactsPatchRoute } from './index';

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

/**
 * The mock provider behind a pass-through that can run one step before
 * the next provider call lands, to change the world mid-request.
 */
interface HookedProvider {
  beforeNextCall(step: () => Promise<void>): void;
  stop(): Promise<void>;
}

async function startHookedProvider(upstreamRoot: string): Promise<HookedProvider> {
  let pendingStep: (() => Promise<void>) | null = null;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const step = pendingStep;
    pendingStep = null;
    if (step) await step();
    const upstream = await fetch(`${upstreamRoot}${req.url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.concat(chunks),
    });
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(await upstream.text());
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as { port: number };
  process.env.MOCK_AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  return {
    beforeNextCall: (step) => {
      pendingStep = step;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const savedMockBaseUrl = process.env.MOCK_AI_BASE_URL;
let mock: MockInferenceServer;
let provider: HookedProvider;
let app: FastifyInstance;

beforeAll(async () => {
  mock = await startMockInferenceServer();
  provider = await startHookedProvider(mock.baseUrl.replace(/\/v1$/, ''));
  app = Fastify({ logger: false });
  setupMemoryFactsPatchRoute(app);
  setupMemoryFactsDeleteRoute(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await provider.stop();
  await mock.stop();
  process.env.MOCK_AI_BASE_URL = savedMockBaseUrl ?? '';
});

async function userWithFact(): Promise<{ userId: string; factId: string }> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const content = "Maria is the user's sister.";
  const fact = await insertUserFact({
    userId,
    content,
    category: 'relationships',
    subject: 'Maria',
    predicate: null,
    object: null,
    embedding: buildMockEmbedding(content),
    modelId: EMBEDDING_MODEL_ID,
    sourceMessageId: null,
    validAt: null,
  });
  return { userId, factId: fact.id };
}

function deleteFact(userId: string, factId: string) {
  return app.inject({
    method: 'DELETE',
    url: `/api/memory/facts/${factId}`,
    headers: { 'x-test-user': userId },
  });
}

function patchFact(userId: string, factId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'PATCH',
    url: `/api/memory/facts/${factId}`,
    headers: { 'x-test-user': userId },
    payload,
  });
}

describe('DELETE /api/memory/facts/:id', () => {
  it('deletes the user\u2019s Fact', async () => {
    const { userId, factId } = await userWithFact();

    expect((await deleteFact(userId, factId)).statusCode).toBe(204);
    expect((await deleteFact(userId, factId)).statusCode).toBe(404);
  });

  it('answers 404 for an unknown id and for another user\u2019s Fact', async () => {
    const { factId } = await userWithFact();
    const stranger = randomUUID();
    await insertUserIfNotExists({ id: stranger });

    expect((await deleteFact(stranger, randomUUID())).statusCode).toBe(404);
    expect((await deleteFact(stranger, factId)).statusCode).toBe(404);
  });

  it('answers 400 for a malformed id', async () => {
    const { userId } = await userWithFact();

    expect((await deleteFact(userId, 'not-a-uuid')).statusCode).toBe(400);
  });
});

describe('PATCH /api/memory/facts/:id', () => {
  it('answers 404 for an unknown id', async () => {
    const { userId } = await userWithFact();

    expect((await patchFact(userId, randomUUID(), { suppressed: true })).statusCode).toBe(404);
    expect((await patchFact(userId, randomUUID(), { content: 'Anything.' })).statusCode).toBe(404);
  });

  it('answers 400 for a malformed id', async () => {
    const { userId } = await userWithFact();

    expect((await patchFact(userId, 'not-a-uuid', { suppressed: true })).statusCode).toBe(400);
  });

  it('answers 404 when a capture supersedes the Fact while the edit is being filed', async () => {
    const { userId, factId } = await userWithFact();
    provider.beforeNextCall(async () => {
      await db
        .updateTable('memory.userFacts')
        .set({ invalidAt: sql`now()` })
        .where('id', '=', factId)
        .execute();
    });

    const response = await patchFact(userId, factId, {
      content: "Maria is the user's older sister.",
    });

    expect(response.statusCode).toBe(404);
    const current = await db
      .selectFrom('memory.userFacts')
      .select('id')
      .where('userId', '=', userId)
      .where('invalidAt', 'is', null)
      .execute();
    expect(current).toEqual([]);
  });

  it('edits a current Fact', async () => {
    const { userId, factId } = await userWithFact();

    const response = await patchFact(userId, factId, {
      content: "Maria is the user's older sister.",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ content: "Maria is the user's older sister." });
  });
});

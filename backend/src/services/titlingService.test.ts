import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { insertMessage } from '@queries/messages/insertMessage';
import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import { insertThreadSegment } from '@queries/threadSegments/insertThreadSegment';
import { deleteThread } from '@queries/threads/deleteThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { autoTitleThread } from '@services/titlingService';
import { useTestDb } from '@test/test-db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../mock/inferenceServer';
import { ErrorCodes } from '../types/errorCodes';
import { EMBEDDING_MODEL_ID } from './aiService/config';

/**
 * e2e against the built-in mock inference server (same documented deviation
 * as aiService.test.ts): titling uses `generateText`, which hits the mock's
 * non-streaming JSON surface. Further tests swap in a local echo/rejection
 * server to pin the request shape (low-effort knobs), the graduated fallback,
 * and the auto vs forced override semantics.
 */

let mock: MockInferenceServer;
const savedMockBaseUrl = process.env.MOCK_AI_BASE_URL;
const savedTitlingTimeoutMs = process.env.AI_TITLING_TIMEOUT_MS;

beforeAll(async () => {
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterEach(() => {
  // Local overrides (echo/rejection servers) restore the file default.
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
  // '' falls back to the 20000ms default in resolveTitlingTimeoutMs().
  process.env.AI_TITLING_TIMEOUT_MS = savedTitlingTimeoutMs ?? '';
});

afterAll(async () => {
  await mock.stop();
  // '' trims to falsy in resolveInferenceConfig — same restore idiom as
  // aiService.test.ts (avoids the `delete` operator lint).
  process.env.MOCK_AI_BASE_URL = savedMockBaseUrl ?? '';
});

useTestDb();

/** Canned `chat.completion` endpoint; records bodies for request-shape asserts. */
async function startProvider(args: {
  title: string;
  onRequest?: (body: unknown) => unknown;
  rejectWhen?: (body: unknown) => boolean;
}) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      try {
        const body: unknown = JSON.parse(raw || '{}');
        await args.onRequest?.(body);
        if (args.rejectWhen?.(body)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'enable_thinking is not supported' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 0,
            model: 'test-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: args.title },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      } catch {
        // A failing callback answers 500, so the test fails instead of waiting on a reply.
        res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as { port: number };
  process.env.MOCK_AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A provider that answers only after a delay (for budget/timeout tests). */
async function startSlowProvider(title: string, delayMs: number) {
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((req, res) => {
    req.resume(); // drain the request body
    timers.add(
      setTimeout(() => {
        try {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion',
              created: 0,
              model: 'test-model',
              choices: [
                { index: 0, message: { role: 'assistant', content: title }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
        } catch {
          // Client already aborted — the response socket is gone.
        }
      }, delayMs),
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as { port: number };
  process.env.MOCK_AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  return async () => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

async function createThread(title?: string) {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId: userId, title: title ?? null });
  return { userId, threadId: thread.id };
}

async function seedExchange(threadId: string) {
  await insertMessage({ threadId, role: 'user', content: 'How do steam engines work?' });
  await insertMessage({
    threadId,
    role: 'assistant',
    content: 'Steam expands and pushes a piston.',
  });
}

/** Two exchanges on two topics + their live-chain segments, for the forced window. */
async function seedDriftedThread(threadId: string) {
  const first = await insertMessage({
    threadId,
    role: 'user',
    content: 'How do steam engines work?',
  });
  await insertMessage({
    threadId,
    role: 'assistant',
    content: 'Steam expands and pushes a piston.',
  });
  const pivot = await insertMessage({
    threadId,
    role: 'user',
    content: 'Switching gears: best pasta recipe?',
  });
  await insertMessage({
    threadId,
    role: 'assistant',
    content: 'Boil salted water, cook the spaghetti al dente.',
  });
  await insertThreadSegment({ threadId, startMessageId: first.id, modelId: EMBEDDING_MODEL_ID });
  return { first: first.id, pivot: pivot.id };
}

/** The prompt text of a captured chat-completion request. */
function promptOf(body: unknown) {
  const messages = (body as { messages?: Array<{ content?: string }> })?.messages ?? [];
  return messages.map((m) => m.content ?? '').join('\n');
}

async function titleOf(userId: string, threadId: string) {
  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) throw new Error('thread vanished');
  return thread.title;
}

describe('autoTitleThread', () => {
  it('generates and persists a low-effort title from the first exchange', async () => {
    const { userId, threadId } = await createThread();
    await seedExchange(threadId);

    let requestBody: Record<string, unknown> | undefined;
    const stop = await startProvider({
      title: 'Steam Engine Basics',
      onRequest: (body) => {
        requestBody = body as Record<string, unknown>;
      },
    });
    try {
      const outcome = await autoTitleThread(userId, threadId);

      expect(outcome).toEqual({ type: 'titled', title: 'Steam Engine Basics' });
      expect(await titleOf(userId, threadId)).toBe('Steam Engine Basics');
      // Low-effort contract: bounded output and the thinking phase skipped
      // via the deployment's actual knob (chat_template_kwargs).
      expect(requestBody?.max_tokens).toBe(40);
      expect(requestBody?.chat_template_kwargs).toEqual({ enable_thinking: false });
    } finally {
      await stop();
    }
  });

  it('skips the thinking knob when the provider rejects it and lands on the bare shape', async () => {
    const { userId, threadId } = await createThread();
    await seedExchange(threadId);

    const requests: unknown[] = [];
    const stop = await startProvider({
      title: 'Piston Power',
      onRequest: (body) => requests.push(body),
      rejectWhen: (body) => 'chat_template_kwargs' in ((body as object) ?? {}),
    });
    try {
      const outcome = await autoTitleThread(userId, threadId);

      expect(outcome).toEqual({ type: 'titled', title: 'Piston Power' });
      // Attempt 1 carried the thinking knob and was rejected; attempt 2 (the
      // bare, uncapped shape) succeeded.
      expect((requests[0] as Record<string, unknown>)?.chat_template_kwargs).toEqual({
        enable_thinking: false,
      });
      expect((requests[1] as Record<string, unknown>)?.chat_template_kwargs).toBeUndefined();
      expect((requests[1] as Record<string, unknown>)?.max_tokens).toBeUndefined();
      expect(requests).toHaveLength(2);
      expect(await titleOf(userId, threadId)).toBe('Piston Power');
    } finally {
      await stop();
    }
  });

  it('falls back to "settled" when there is no exchange to learn from', async () => {
    const { userId, threadId } = await createThread();

    const outcome = await autoTitleThread(userId, threadId);

    expect(outcome).toEqual({ type: 'settled' });
    expect(await titleOf(userId, threadId)).toBeNull();
  });

  it('never overwrites a user-chosen title when generation cannot run', async () => {
    const { userId, threadId } = await createThread('My important notes');

    const outcome = await autoTitleThread(userId, threadId);

    expect(outcome).toEqual({ type: 'settled' });
    expect(await titleOf(userId, threadId)).toBe('My important notes');
  });

  it('fails when every attempt fails', async () => {
    const { userId, threadId } = await createThread();
    await seedExchange(threadId);

    const requests: unknown[] = [];
    const stop = await startProvider({
      title: '',
      onRequest: (body) => requests.push(body),
      rejectWhen: () => true, // kills both graduated attempts
    });
    try {
      const outcome = await autoTitleThread(userId, threadId);

      expect(outcome).toEqual({
        type: 'failed',
        code: ErrorCodes.TITLE_PROVIDER_ERROR,
        message: expect.any(String),
      });
      expect(requests).toHaveLength(2);
      expect(await titleOf(userId, threadId)).toBeNull();
    } finally {
      await stop();
    }
  });

  it('climbs to the final shape when every attempt answers with empty content', async () => {
    const { userId, threadId } = await createThread();
    await seedExchange(threadId);

    const requests: unknown[] = [];
    const stop = await startProvider({
      title: '', // accepted shape, empty content
      onRequest: (body) => requests.push(body),
    });
    try {
      const outcome = await autoTitleThread(userId, threadId);

      expect(outcome).toEqual({
        type: 'failed',
        code: ErrorCodes.TITLE_EMPTY_RESPONSE,
        message: expect.any(String),
      });
      // Empty content climbs the ladder just like a rejected shape: both
      // attempts ran, the last one bare and uncapped by design (caps get
      // consumed by reasoning —).
      expect(requests).toHaveLength(2);
      expect((requests[1] as Record<string, unknown>)?.max_tokens).toBeUndefined();
      expect((requests[1] as Record<string, unknown>)?.chat_template_kwargs).toBeUndefined();
      expect(await titleOf(userId, threadId)).toBeNull();
    } finally {
      await stop();
    }
  });

  it('reports title_timeout when the shared budget fires mid-call', async () => {
    const { userId, threadId } = await createThread();
    await seedExchange(threadId);

    process.env.AI_TITLING_TIMEOUT_MS = '100';
    const stop = await startSlowProvider('Too Late', 2000);
    try {
      const outcome = await autoTitleThread(userId, threadId);

      expect(outcome).toMatchObject({ type: 'failed', code: ErrorCodes.TITLE_TIMEOUT });
      expect(outcome.type === 'failed' && outcome.message).toContain('aborted after 100ms');
      expect(await titleOf(userId, threadId)).toBeNull();
    } finally {
      await stop();
    }
  });

  it('fails fast with provider_not_configured without a base URL and key', async () => {
    const { userId, threadId } = await createThread();
    await seedExchange(threadId);

    const savedKey = process.env.DEEPINFRA_API_KEY;
    process.env.MOCK_AI_BASE_URL = '';
    process.env.DEEPINFRA_API_KEY = '';
    try {
      const outcome = await autoTitleThread(userId, threadId);

      expect(outcome).toEqual({
        type: 'failed',
        code: ErrorCodes.PROVIDER_NOT_CONFIGURED,
        message: expect.any(String),
      });
    } finally {
      process.env.DEEPINFRA_API_KEY = savedKey === undefined ? '' : savedKey;
    }
  });

  it('reports thread_not_found for a foreign or missing thread id', async () => {
    const userId = randomUUID();

    const outcome = await autoTitleThread(userId, randomUUID());

    expect(outcome).toEqual({
      type: 'failed',
      code: ErrorCodes.THREAD_NOT_FOUND,
      message: expect.any(String),
    });
  });

  it('generation overwrites a human-chosen title', async () => {
    const { userId, threadId } = await createThread('My important notes');
    await seedExchange(threadId);

    const stop = await startProvider({ title: 'Steam Engines Explained' });
    try {
      const outcome = await autoTitleThread(userId, threadId);

      expect(outcome).toEqual({ type: 'titled', title: 'Steam Engines Explained' });
      expect(await titleOf(userId, threadId)).toBe('Steam Engines Explained');
    } finally {
      await stop();
    }
  });
});

describe('autoTitleThread message selection', () => {
  it('leaves out text the user edited away', async () => {
    const { userId, threadId } = await createThread();
    const edited = await insertMessage({
      threadId,
      role: 'user',
      content: 'Tell me about volcanoes',
    });
    const staleReply = await insertMessage({
      threadId,
      role: 'assistant',
      content: 'Volcanoes erupt molten rock.',
    });
    await setMessagesAbandoned({ messageIds: [edited.id, staleReply.id], abandoned: true });
    await seedExchange(threadId);

    let requestBody: unknown;
    const stop = await startProvider({
      title: 'Steam Engine Basics',
      onRequest: (body) => {
        requestBody = body;
      },
    });
    try {
      const outcome = await autoTitleThread(userId, threadId);

      expect(outcome.type).toBe('titled');
      const prompt = promptOf(requestBody);
      expect(prompt).toContain('steam engines');
      expect(prompt).not.toContain('volcano');
    } finally {
      await stop();
    }
  });

  it('settles while the reply is still an empty row', async () => {
    const { userId, threadId } = await createThread();
    await insertMessage({ threadId, role: 'user', content: 'How do steam engines work?' });
    await insertMessage({ threadId, role: 'assistant', content: '' });

    const outcome = await autoTitleThread(userId, threadId);

    expect(outcome).toEqual({ type: 'settled' });
  });
});

describe('autoTitleThread title storage', () => {
  it('cuts a title longer than a Thread title may be', async () => {
    const { userId, threadId } = await createThread();
    await seedExchange(threadId);

    const stop = await startProvider({ title: 'A very long title that goes on and on '.repeat(3) });
    try {
      const outcome = await autoTitleThread(userId, threadId);

      expect(outcome.type).toBe('titled');
      const stored = await titleOf(userId, threadId);
      expect(stored).toBe('A very long title that goes on and on A very long');
      expect(outcome).toEqual({ type: 'titled', title: stored });
    } finally {
      await stop();
    }
  });

  it('reports thread_not_found when the Thread is deleted while the title is generated', async () => {
    const { userId, threadId } = await createThread();
    await seedExchange(threadId);

    const stop = await startProvider({
      title: 'Steam Engine Basics',
      onRequest: async () => {
        await deleteThread({ userId, threadId });
      },
    });
    try {
      const outcome = await autoTitleThread(userId, threadId);

      expect(outcome).toEqual({
        type: 'failed',
        code: ErrorCodes.THREAD_NOT_FOUND,
        message: expect.any(String),
      });
    } finally {
      await stop();
    }
  });
});

describe('autoTitleThread message window', () => {
  it('auto keeps learning from the first exchange on a drifted thread', async () => {
    const { userId, threadId } = await createThread();
    const { pivot } = await seedDriftedThread(threadId);
    await insertThreadSegment({ threadId, startMessageId: pivot, modelId: EMBEDDING_MODEL_ID });

    let requestBody: unknown;
    const stop = await startProvider({
      title: 'Steam Engine Basics',
      onRequest: (body) => {
        requestBody = body;
      },
    });
    try {
      const outcome = await autoTitleThread(userId, threadId);

      expect(outcome.type).toBe('titled');
      const prompt = promptOf(requestBody);
      expect(prompt).toContain('steam engines');
      expect(prompt).not.toContain('pasta');
    } finally {
      await stop();
    }
  });

  it('forced regeneration names the thread from its first full segment', async () => {
    const { userId, threadId } = await createThread();
    const { pivot } = await seedDriftedThread(threadId);
    // Drift cuts a second segment at the pasta question — the first
    // segment ends right before it.
    await insertThreadSegment({ threadId, startMessageId: pivot, modelId: EMBEDDING_MODEL_ID });

    let requestBody: unknown;
    const stop = await startProvider({
      title: 'Steam Engine Basics',
      onRequest: (body) => {
        requestBody = body;
      },
    });
    try {
      const outcome = await autoTitleThread(userId, threadId, true);

      expect(outcome.type).toBe('titled');
      const prompt = promptOf(requestBody);
      expect(prompt).toContain('steam engines');
      expect(prompt).toContain('pushes a piston');
      expect(prompt).not.toContain('pasta');
      expect(prompt).not.toContain('spaghetti');
    } finally {
      await stop();
    }
  });

  it('forced regeneration still ends at a segment that starts at an edited-away message', async () => {
    const { userId, threadId } = await createThread();
    const { pivot } = await seedDriftedThread(threadId);
    await insertThreadSegment({ threadId, startMessageId: pivot, modelId: EMBEDDING_MODEL_ID });
    await setMessagesAbandoned({ messageIds: [pivot], abandoned: true });

    let requestBody: unknown;
    const stop = await startProvider({
      title: 'Steam Engine Basics',
      onRequest: (body) => {
        requestBody = body;
      },
    });
    try {
      const outcome = await autoTitleThread(userId, threadId, true);

      expect(outcome.type).toBe('titled');
      const prompt = promptOf(requestBody);
      expect(prompt).toContain('steam engines');
      expect(prompt).not.toContain('spaghetti');
    } finally {
      await stop();
    }
  });

  it('forced regeneration uses the whole thread while no drift boundary exists', async () => {
    const { userId, threadId } = await createThread();
    // Only the first segment — the thread has not drifted, so it is still
    // one segment and the whole conversation names it.
    await seedDriftedThread(threadId);

    let requestBody: unknown;
    const stop = await startProvider({
      title: 'Steam Then Pasta',
      onRequest: (body) => {
        requestBody = body;
      },
    });
    try {
      const outcome = await autoTitleThread(userId, threadId, true);

      expect(outcome.type).toBe('titled');
      const prompt = promptOf(requestBody);
      expect(prompt).toContain('steam engines');
      expect(prompt).toContain('pasta');
    } finally {
      await stop();
    }
  });
});

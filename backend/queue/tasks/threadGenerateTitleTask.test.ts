import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { insertMessage } from '@queries/messages/insertMessage';
import { deleteThread } from '@queries/threads/deleteThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { enqueueThreadGenerateTitle, titleThread } from '@queue/tasks/threadGenerateTitleTask';
import { queueTasks } from '@queue/worker';
import { type ServerEvent, subscribe } from '@services/events';
import { drainQueue } from '@test/queue';
import { useTestDb } from '@test/test-db';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The Thread's titling as queued work: it titles through the queue, holds
 * off an already-titled Thread, re-titles when forced, and announces the
 * title it lands.
 */

const savedMockBaseUrl = process.env.MOCK_AI_BASE_URL;

afterEach(() => {
  process.env.MOCK_AI_BASE_URL = savedMockBaseUrl ?? '';
});

useTestDb();

/** Canned `chat.completion` endpoint; counts the requests it answers. */
async function startProvider(args: { title: string }) {
  const requests: { count: number } = { count: 0 };
  const server = http.createServer((req, res) => {
    req.resume(); // drain the request body
    requests.count += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: args.title }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as { port: number };
  process.env.MOCK_AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  return {
    requests,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** An untitled thread with one settled Exchange to learn from. */
async function untitledThreadWithExchange() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId });
  await insertMessage({ threadId, role: 'user', content: 'How do steam engines work?' });
  await insertMessage({
    threadId,
    role: 'assistant',
    content: 'Steam expands and pushes a piston.',
  });
  return { userId, threadId };
}

async function titleOf(userId: string, threadId: string): Promise<string | null> {
  return (await findThreadByIdAndUser({ userId, threadId }))?.title ?? null;
}

describe('threadGenerateTitle on the worker', () => {
  it('titles an untitled Thread and announces it', async () => {
    const { userId, threadId } = await untitledThreadWithExchange();
    const provider = await startProvider({ title: 'Steam Engine Basics' });
    const events: ServerEvent[] = [];
    const unsubscribe = subscribe(
      (event) => event.threadId === threadId,
      (event) => events.push(event),
    );
    try {
      await enqueueThreadGenerateTitle({ userId, threadId, forced: false });
      await drainQueue(queueTasks());

      expect(await titleOf(userId, threadId)).toBe('Steam Engine Basics');
      expect(events).toEqual([
        { kind: 'thread-titled', userId, threadId, title: 'Steam Engine Basics' },
      ]);
    } finally {
      unsubscribe();
      await provider.stop();
    }
  });

  it('titles once however often it was queued while waiting', async () => {
    const { userId, threadId } = await untitledThreadWithExchange();
    const provider = await startProvider({ title: 'Steam Engine Basics' });
    try {
      await enqueueThreadGenerateTitle({ userId, threadId, forced: false });
      await enqueueThreadGenerateTitle({ userId, threadId, forced: false });
      await drainQueue(queueTasks());

      expect(await titleOf(userId, threadId)).toBe('Steam Engine Basics');
      expect(provider.requests.count).toBe(1);
    } finally {
      await provider.stop();
    }
  });

  it('leaves an already-titled Thread alone and stays quiet', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const { id: threadId } = await insertThread({ userId, title: 'My important notes' });
    await insertMessage({ threadId, role: 'user', content: 'How do steam engines work?' });
    await insertMessage({ threadId, role: 'assistant', content: 'Steam pushes a piston.' });
    const provider = await startProvider({ title: 'Never Used' });
    const events: ServerEvent[] = [];
    const unsubscribe = subscribe(
      (event) => event.threadId === threadId,
      (event) => events.push(event),
    );
    try {
      await enqueueThreadGenerateTitle({ userId, threadId, forced: false });
      await drainQueue(queueTasks());

      expect(await titleOf(userId, threadId)).toBe('My important notes');
      expect(provider.requests.count).toBe(0);
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
      await provider.stop();
    }
  });

  it('re-titles an already-titled Thread when forced', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const { id: threadId } = await insertThread({ userId, title: 'My important notes' });
    await insertMessage({ threadId, role: 'user', content: 'How do steam engines work?' });
    await insertMessage({ threadId, role: 'assistant', content: 'Steam pushes a piston.' });
    const provider = await startProvider({ title: 'Steam Engines Explained' });
    const events: ServerEvent[] = [];
    const unsubscribe = subscribe(
      (event) => event.threadId === threadId,
      (event) => events.push(event),
    );
    try {
      await enqueueThreadGenerateTitle({ userId, threadId, forced: true });
      await drainQueue(queueTasks());

      expect(await titleOf(userId, threadId)).toBe('Steam Engines Explained');
      expect(events).toEqual([
        { kind: 'thread-titled', userId, threadId, title: 'Steam Engines Explained' },
      ]);
    } finally {
      unsubscribe();
      await provider.stop();
    }
  });

  it('quietly settles a titling whose Thread is gone', async () => {
    const { userId, threadId } = await untitledThreadWithExchange();
    await deleteThread({ userId, threadId });

    await enqueueThreadGenerateTitle({ userId, threadId, forced: false });
    await drainQueue(queueTasks());

    expect(await findThreadByIdAndUser({ userId, threadId })).toBeUndefined();
  });
});

describe('titleThread', () => {
  it('leaves the database unchanged when run a second time', async () => {
    const { userId, threadId } = await untitledThreadWithExchange();
    const provider = await startProvider({ title: 'Steam Engine Basics' });
    try {
      const first = await titleThread({ userId, threadId, forced: false });
      const second = await titleThread({ userId, threadId, forced: false });

      expect(first).toEqual({ kind: 'titled', userId, threadId, title: 'Steam Engine Basics' });
      expect(second).toEqual({ kind: 'settled' });
      expect(provider.requests.count).toBe(1);
      expect(await titleOf(userId, threadId)).toBe('Steam Engine Basics');
    } finally {
      await provider.stop();
    }
  });

  it('reports a gone Thread without asking the provider', async () => {
    const userId = randomUUID();
    const provider = await startProvider({ title: 'Never Used' });
    try {
      expect(await titleThread({ userId, threadId: randomUUID(), forced: false })).toEqual({
        kind: 'gone',
      });
      expect(provider.requests.count).toBe(0);
    } finally {
      await provider.stop();
    }
  });
});

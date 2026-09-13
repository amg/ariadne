import { randomUUID } from 'node:crypto';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { createEchoResponse, getMessages, submitMessage } from '@services/messageService';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createRandomThread(db: ReturnType<typeof useTestDb>): Promise<string> {
  const userId = randomUUID();
  await insertUserIfNotExists(db, userId);
  const thread = await insertThread(db, { user_id: userId, title: 'Test thread' });
  return thread.id;
}

describe('messageService', () => {
  const db = useTestDb();

  describe('createEchoResponse', () => {
    it('prefixes the user content with "Echo: "', () => {
      expect(createEchoResponse('hi')).toBe('Echo: hi');
    });

    it('handles empty content', () => {
      expect(createEchoResponse('')).toBe('Echo: ');
    });
  });

  describe('submitMessage', () => {
    it('persists the user message and the assistant echo and returns both', async () => {
      const threadId = await createRandomThread(db);

      const { userMessage, assistantMessage } = await submitMessage(db, threadId, 'hello');

      expect(userMessage.role).toBe('user');
      expect(userMessage.content).toBe('hello');
      expect(userMessage.thread_id).toBe(threadId);
      expect(assistantMessage.role).toBe('assistant');
      expect(assistantMessage.content).toBe('Echo: hello');
      expect(assistantMessage.thread_id).toBe(threadId);
      expect(userMessage.id).not.toBe(assistantMessage.id);

      // Both rows are actually persisted, in conversation order
      const messages = await getMessages(db, threadId);
      expect(messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'hello'],
        ['assistant', 'Echo: hello'],
      ]);
    });

    it('surfaces the FK violation for an unknown thread', async () => {
      await expect(submitMessage(db, randomUUID(), 'hello')).rejects.toMatchObject({
        code: '23503',
      });
    });
  });

  describe('getMessages', () => {
    it('returns an empty list for a thread without messages', async () => {
      const threadId = await createRandomThread(db);

      const messages = await getMessages(db, threadId);

      expect(messages).toEqual([]);
    });

    it('returns messages in conversation order for one thread only', async () => {
      const threadId = await createRandomThread(db);
      const otherThreadId = await createRandomThread(db);

      await submitMessage(db, threadId, 'one');
      await submitMessage(db, threadId, 'two');
      await submitMessage(db, otherThreadId, 'other thread');

      const messages = await getMessages(db, threadId);

      expect(messages.map((m) => m.content)).toEqual(['one', 'Echo: one', 'two', 'Echo: two']);
    });
  });
});

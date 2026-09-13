import { randomUUID } from 'node:crypto';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { createEchoResponse, getMessages, submitMessage } from '@services/messageService';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createRandomThread(db: ReturnType<typeof useTestDb>) {
  const userId = randomUUID();
  await insertUserIfNotExists(db, userId);
  const thread = await insertThread(db, { user_id: userId, title: 'Test thread' });
  return { userId, threadId: thread.id };
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
      const { userId, threadId } = await createRandomThread(db);

      const result = await submitMessage(db, userId, threadId, 'hello');

      expect(result).not.toBeNull();
      if (!result) return;
      const { userMessage, assistantMessage } = result;
      expect(userMessage.role).toBe('user');
      expect(userMessage.content).toBe('hello');
      expect(userMessage.thread_id).toBe(threadId);
      expect(assistantMessage.role).toBe('assistant');
      expect(assistantMessage.content).toBe('Echo: hello');
      expect(assistantMessage.thread_id).toBe(threadId);
      expect(userMessage.id).not.toBe(assistantMessage.id);

      // Both rows are actually persisted, in conversation order
      const messages = await getMessages(db, userId, threadId);
      expect(messages?.map((m) => [m.role, m.content])).toEqual([
        ['user', 'hello'],
        ['assistant', 'Echo: hello'],
      ]);
    });

    it('returns null for an unknown thread', async () => {
      const { userId } = await createRandomThread(db);

      await expect(submitMessage(db, userId, randomUUID(), 'hello')).resolves.toBeNull();
    });

    it('returns null and persists nothing for another user’s thread', async () => {
      const { userId, threadId } = await createRandomThread(db);
      const stranger = randomUUID();
      await insertUserIfNotExists(db, stranger);

      await expect(submitMessage(db, stranger, threadId, 'hello')).resolves.toBeNull();

      const messages = await getMessages(db, userId, threadId);
      expect(messages).toEqual([]);
    });
  });

  describe('getMessages', () => {
    it('returns an empty list for a thread without messages', async () => {
      const { userId, threadId } = await createRandomThread(db);

      const messages = await getMessages(db, userId, threadId);

      expect(messages).toEqual([]);
    });

    it('returns messages in conversation order for one thread only', async () => {
      const { userId, threadId } = await createRandomThread(db);
      const other = await createRandomThread(db);

      await submitMessage(db, userId, threadId, 'one');
      await submitMessage(db, userId, threadId, 'two');
      await submitMessage(db, other.userId, other.threadId, 'other thread');

      const messages = await getMessages(db, userId, threadId);

      expect(messages?.map((m) => m.content)).toEqual(['one', 'Echo: one', 'two', 'Echo: two']);
    });

    it('returns null for another user’s thread (indistinguishable from unknown)', async () => {
      const { threadId } = await createRandomThread(db);
      const stranger = randomUUID();
      await insertUserIfNotExists(db, stranger);

      await expect(getMessages(db, stranger, threadId)).resolves.toBeNull();
    });

    it('returns null for an unknown thread', async () => {
      const { userId } = await createRandomThread(db);

      await expect(getMessages(db, userId, randomUUID())).resolves.toBeNull();
    });
  });
});

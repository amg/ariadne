import { randomUUID } from 'node:crypto';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { createEchoResponse, getMessages, submitMessage } from '@services/messageService';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createRandomThread() {
  const userId = randomUUID();
  await insertUserIfNotExists(userId);
  const thread = await insertThread({ user_id: userId, title: 'Test thread' });
  return { userId, threadId: thread.id };
}

describe('messageService', () => {
  useTestDb();

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
      const { userId, threadId } = await createRandomThread();

      const result = await submitMessage(userId, threadId, 'hello');

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
      const messages = await getMessages(userId, threadId);
      expect(messages?.map((m) => [m.role, m.content])).toEqual([
        ['user', 'hello'],
        ['assistant', 'Echo: hello'],
      ]);
    });

    it('returns null for an unknown thread', async () => {
      const { userId } = await createRandomThread();

      await expect(submitMessage(userId, randomUUID(), 'hello')).resolves.toBeNull();
    });

    it('returns null and persists nothing for another user’s thread', async () => {
      const { userId, threadId } = await createRandomThread();
      const stranger = randomUUID();
      await insertUserIfNotExists(stranger);

      await expect(submitMessage(stranger, threadId, 'hello')).resolves.toBeNull();

      const messages = await getMessages(userId, threadId);
      expect(messages).toEqual([]);
    });
  });

  describe('getMessages', () => {
    it('returns an empty list for a thread without messages', async () => {
      const { userId, threadId } = await createRandomThread();

      const messages = await getMessages(userId, threadId);

      expect(messages).toEqual([]);
    });

    it('returns messages in conversation order for one thread only', async () => {
      const { userId, threadId } = await createRandomThread();
      const other = await createRandomThread();

      await submitMessage(userId, threadId, 'one');
      await submitMessage(userId, threadId, 'two');
      await submitMessage(other.userId, other.threadId, 'other thread');

      const messages = await getMessages(userId, threadId);

      expect(messages?.map((m) => m.content)).toEqual(['one', 'Echo: one', 'two', 'Echo: two']);
    });

    it('returns null for another user’s thread (indistinguishable from unknown)', async () => {
      const { threadId } = await createRandomThread();
      const stranger = randomUUID();
      await insertUserIfNotExists(stranger);

      await expect(getMessages(stranger, threadId)).resolves.toBeNull();
    });

    it('returns null for an unknown thread', async () => {
      const { userId } = await createRandomThread();

      await expect(getMessages(userId, randomUUID())).resolves.toBeNull();
    });
  });
});

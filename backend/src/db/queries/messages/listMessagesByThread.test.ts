import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createRandomThread(db: ReturnType<typeof useTestDb>): Promise<string> {
  const userId = randomUUID();
  await insertUserIfNotExists(db, userId);
  const thread = await insertThread(db, { user_id: userId, title: 'Test thread' });
  return thread.id;
}

describe('listMessagesByThread', () => {
  const db = useTestDb();

  it('returns an empty list when the thread has no messages', async () => {
    const threadId = await createRandomThread(db);

    const messages = await listMessagesByThread(db, threadId);

    expect(messages).toEqual([]);
  });

  it('returns an empty list for an unknown thread id', async () => {
    const messages = await listMessagesByThread(db, randomUUID());

    expect(messages).toEqual([]);
  });

  it('returns only messages belonging to the given thread', async () => {
    const threadId = await createRandomThread(db);
    const otherThreadId = await createRandomThread(db);

    await insertMessage(db, { thread_id: threadId, role: 'user', content: 'Mine' });
    await insertMessage(db, { thread_id: otherThreadId, role: 'user', content: 'Not mine' });

    const messages = await listMessagesByThread(db, threadId);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('Mine');
    expect(messages[0]?.thread_id).toBe(threadId);
  });

  it('orders messages oldest first', async () => {
    const threadId = await createRandomThread(db);

    await insertMessage(db, {
      thread_id: threadId,
      role: 'user',
      content: 'Newer',
      created_at: new Date('2024-06-01T00:00:01.000Z'),
    });
    await insertMessage(db, {
      thread_id: threadId,
      role: 'assistant',
      content: 'Older',
      created_at: new Date('2024-06-01T00:00:00.000Z'),
    });

    const messages = await listMessagesByThread(db, threadId);

    expect(messages.map((m) => m.content)).toEqual(['Older', 'Newer']);
  });
});

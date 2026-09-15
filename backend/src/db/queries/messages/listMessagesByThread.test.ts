import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createRandomThread(): Promise<string> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId: userId, title: 'Test thread' });
  return thread.id;
}

describe('listMessagesByThread', () => {
  useTestDb();

  it('returns an empty list when the thread has no messages', async () => {
    const threadId = await createRandomThread();

    const messages = await listMessagesByThread({ threadId });

    expect(messages).toEqual([]);
  });

  it('returns an empty list for an unknown thread id', async () => {
    const messages = await listMessagesByThread({ threadId: randomUUID() });

    expect(messages).toEqual([]);
  });

  it('returns only messages belonging to the given thread', async () => {
    const threadId = await createRandomThread();
    const otherThreadId = await createRandomThread();

    await insertMessage({ threadId: threadId, role: 'user', content: 'Mine' });
    await insertMessage({ threadId: otherThreadId, role: 'user', content: 'Not mine' });

    const messages = await listMessagesByThread({ threadId });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('Mine');
    expect(messages[0]?.threadId).toBe(threadId);
  });

  it('orders messages oldest first', async () => {
    const threadId = await createRandomThread();

    await insertMessage({
      threadId: threadId,
      role: 'user',
      content: 'Newer',
      createdAt: new Date('2024-06-01T00:00:01.000Z'),
    });
    await insertMessage({
      threadId: threadId,
      role: 'assistant',
      content: 'Older',
      createdAt: new Date('2024-06-01T00:00:00.000Z'),
    });

    const messages = await listMessagesByThread({ threadId });

    expect(messages.map((m) => m.content)).toEqual(['Older', 'Newer']);
  });

  it('returns null usage columns when the message has no usage row', async () => {
    const threadId = await createRandomThread();
    await insertMessage({ threadId: threadId, role: 'user', content: 'no usage' });

    const [row] = await listMessagesByThread({ threadId });

    expect(row?.usageModel).toBeNull();
    expect(row?.usageCostUsd).toBeNull();
    expect(row?.usageLatencyMs).toBeNull();
  });
});

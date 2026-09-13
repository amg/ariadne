import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createRandomThread(): Promise<string> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ user_id: userId, title: 'Test thread' });
  return thread.id;
}

describe('insertMessage', () => {
  useTestDb();

  it('inserts a message and returns the full row with generated fields', async () => {
    const threadId = await createRandomThread();

    const message = await insertMessage({
      thread_id: threadId,
      role: 'user',
      content: 'Hello, world!',
    });

    expect(message.id).toBeTypeOf('string');
    expect(message.id.length).toBeGreaterThan(0);
    expect(message.thread_id).toBe(threadId);
    expect(message.role).toBe('user');
    expect(message.content).toBe('Hello, world!');
    expect(message.created_at).toBeInstanceOf(Date);
  });

  it('round-trips unicode content', async () => {
    const threadId = await createRandomThread();
    const content = 'Héllo 🌍 —日本語—';

    const message = await insertMessage({
      thread_id: threadId,
      role: 'assistant',
      content,
    });

    expect(message.content).toBe(content);
    expect(message.role).toBe('assistant');
  });

  it('rejects when the thread does not exist (FK violation)', async () => {
    await expect(
      insertMessage({
        thread_id: randomUUID(),
        role: 'user',
        content: 'Orphan message',
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects when content is missing (NOT NULL)', async () => {
    const threadId = await createRandomThread();

    const values = { thread_id: threadId, role: 'user' as const } as {
      thread_id: string;
      role: 'user';
      content: string;
    };

    await expect(insertMessage(values)).rejects.toMatchObject({ code: '23502' });
  });
});

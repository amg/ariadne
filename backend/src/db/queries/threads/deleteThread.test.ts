import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { deleteThread } from '@queries/threads/deleteThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function seedUserAndThread(title: string) {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId: userId, title });
  return { userId, thread };
}

describe('deleteThread', () => {
  useTestDb();

  it('deletes the thread and reports success', async () => {
    const { userId, thread } = await seedUserAndThread('Doomed');

    const deleted = await deleteThread({ userId, threadId: thread.id });

    expect(deleted).toBe(true);
    expect(await findThreadByIdAndUser({ userId, threadId: thread.id })).toBeUndefined();
  });

  it('cascades to the thread messages', async () => {
    const { userId, thread } = await seedUserAndThread('With messages');
    await insertMessage({ threadId: thread.id, role: 'user', content: 'hello' });
    await insertMessage({ threadId: thread.id, role: 'assistant', content: 'hi' });

    await deleteThread({ userId, threadId: thread.id });

    expect(await listMessagesByThread({ threadId: thread.id })).toHaveLength(0);
  });

  it('does not touch other threads of the same user', async () => {
    const { userId, thread } = await seedUserAndThread('First');
    const second = await insertThread({ userId: userId, title: 'Second' });

    await deleteThread({ userId, threadId: thread.id });

    expect(await findThreadByIdAndUser({ userId, threadId: second.id })).toBeDefined();
  });

  it('refuses to delete another user thread', async () => {
    const { userId, thread } = await seedUserAndThread('Kept');
    const stranger = randomUUID();
    await insertUserIfNotExists({ id: stranger });

    const deleted = await deleteThread({ userId: stranger, threadId: thread.id });

    expect(deleted).toBe(false);
    expect(await findThreadByIdAndUser({ userId, threadId: thread.id })).toBeDefined();
  });

  it('returns false when no thread has the given id', async () => {
    const { userId } = await seedUserAndThread('Any');

    const deleted = await deleteThread({ userId, threadId: randomUUID() });

    expect(deleted).toBe(false);
  });
});

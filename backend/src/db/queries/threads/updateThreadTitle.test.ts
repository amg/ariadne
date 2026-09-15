import { randomUUID } from 'node:crypto';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { insertThread } from '@queries/threads/insertThread';
import { updateThreadTitle } from '@queries/threads/updateThreadTitle';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function seedUserAndThread(title: string) {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId: userId, title });
  return { userId, thread };
}

describe('updateThreadTitle', () => {
  useTestDb();

  it('updates the title and returns the updated row', async () => {
    const { userId, thread } = await seedUserAndThread('Before');

    const updated = await updateThreadTitle({ userId, threadId: thread.id, title: 'After' });

    expect(updated?.id).toBe(thread.id);
    expect(updated?.title).toBe('After');
  });

  it('does not touch other threads', async () => {
    const { userId, thread } = await seedUserAndThread('First');
    const second = await insertThread({ userId: userId, title: 'Second' });

    await updateThreadTitle({ userId, threadId: thread.id, title: 'Renamed' });

    expect((await updateThreadTitle({ userId, threadId: second.id, title: 'Still' }))?.title).toBe(
      'Still',
    );
  });

  it('refuses to rename another user thread', async () => {
    const { userId, thread } = await seedUserAndThread('Owned');
    const stranger = randomUUID();
    await insertUserIfNotExists({ id: stranger });

    const updated = await updateThreadTitle({
      userId: stranger,
      threadId: thread.id,
      title: 'Stolen',
    });

    expect(updated).toBeUndefined();
    // Original title untouched by the foreign attempt
    expect((await findThreadByIdAndUser({ userId, threadId: thread.id }))?.title).toBe('Owned');
  });

  it('returns undefined when no thread has the given id', async () => {
    const { userId } = await seedUserAndThread('Any');

    const updated = await updateThreadTitle({ userId, threadId: randomUUID(), title: 'Nope' });

    expect(updated).toBeUndefined();
  });
});

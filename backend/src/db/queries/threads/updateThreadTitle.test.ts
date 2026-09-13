import { randomUUID } from 'node:crypto';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { insertThread } from '@queries/threads/insertThread';
import { updateThreadTitle } from '@queries/threads/updateThreadTitle';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function seedUserAndThread(title: string) {
  const userId = randomUUID();
  await insertUserIfNotExists(userId);
  const thread = await insertThread({ user_id: userId, title });
  return { userId, thread };
}

describe('updateThreadTitle', () => {
  useTestDb();

  it('updates the title and returns the updated row', async () => {
    const { userId, thread } = await seedUserAndThread('Before');

    const updated = await updateThreadTitle(userId, thread.id, 'After');

    expect(updated?.id).toBe(thread.id);
    expect(updated?.title).toBe('After');
  });

  it('does not touch other threads', async () => {
    const { userId, thread } = await seedUserAndThread('First');
    const second = await insertThread({ user_id: userId, title: 'Second' });

    await updateThreadTitle(userId, thread.id, 'Renamed');

    expect((await updateThreadTitle(userId, second.id, 'Still'))?.title).toBe('Still');
  });

  it('refuses to rename another user’s thread', async () => {
    const { userId, thread } = await seedUserAndThread('Owned');
    const stranger = randomUUID();
    await insertUserIfNotExists(stranger);

    const updated = await updateThreadTitle(stranger, thread.id, 'Stolen');

    expect(updated).toBeUndefined();
    // Original title untouched by the foreign attempt
    expect((await findThreadByIdAndUser(userId, thread.id))?.title).toBe('Owned');
  });

  it('returns undefined when no thread has the given id', async () => {
    const { userId } = await seedUserAndThread('Any');

    const updated = await updateThreadTitle(userId, randomUUID(), 'Nope');

    expect(updated).toBeUndefined();
  });
});

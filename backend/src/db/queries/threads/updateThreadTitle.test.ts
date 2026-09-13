import { randomUUID } from 'node:crypto';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { insertThread } from '@queries/threads/insertThread';
import { updateThreadTitle } from '@queries/threads/updateThreadTitle';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function seedUserAndThread(db: ReturnType<typeof useTestDb>, title: string) {
  const userId = randomUUID();
  await insertUserIfNotExists(db, userId);
  const thread = await insertThread(db, { user_id: userId, title });
  return { userId, thread };
}

describe('updateThreadTitle', () => {
  const db = useTestDb();

  it('updates the title and returns the updated row', async () => {
    const { userId, thread } = await seedUserAndThread(db, 'Before');

    const updated = await updateThreadTitle(db, userId, thread.id, 'After');

    expect(updated?.id).toBe(thread.id);
    expect(updated?.title).toBe('After');
  });

  it('does not touch other threads', async () => {
    const { userId, thread } = await seedUserAndThread(db, 'First');
    const second = await insertThread(db, { user_id: userId, title: 'Second' });

    await updateThreadTitle(db, userId, thread.id, 'Renamed');

    expect((await updateThreadTitle(db, userId, second.id, 'Still'))?.title).toBe('Still');
  });

  it('refuses to rename another user’s thread', async () => {
    const { userId, thread } = await seedUserAndThread(db, 'Owned');
    const stranger = randomUUID();
    await insertUserIfNotExists(db, stranger);

    const updated = await updateThreadTitle(db, stranger, thread.id, 'Stolen');

    expect(updated).toBeUndefined();
    // Original title untouched by the foreign attempt
    expect((await findThreadByIdAndUser(db, userId, thread.id))?.title).toBe('Owned');
  });

  it('returns undefined when no thread has the given id', async () => {
    const { userId } = await seedUserAndThread(db, 'Any');

    const updated = await updateThreadTitle(db, userId, randomUUID(), 'Nope');

    expect(updated).toBeUndefined();
  });
});

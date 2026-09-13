import { randomUUID } from 'node:crypto';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

describe('findThreadByIdAndUser', () => {
  const db = useTestDb();

  it('returns the thread when the user owns it', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists(db, userId);
    const thread = await insertThread(db, { user_id: userId, title: 'Mine' });

    const found = await findThreadByIdAndUser(db, userId, thread.id);

    expect(found?.id).toBe(thread.id);
    expect(found?.title).toBe('Mine');
  });

  it('returns undefined for another user’s thread', async () => {
    const owner = randomUUID();
    const stranger = randomUUID();
    await insertUserIfNotExists(db, owner);
    await insertUserIfNotExists(db, stranger);
    const thread = await insertThread(db, { user_id: owner, title: 'Not yours' });

    const found = await findThreadByIdAndUser(db, stranger, thread.id);

    expect(found).toBeUndefined();
  });

  it('returns undefined for an unknown thread id', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists(db, userId);

    const found = await findThreadByIdAndUser(db, userId, randomUUID());

    expect(found).toBeUndefined();
  });
});

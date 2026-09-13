import { randomUUID } from 'node:crypto';
import { insertThread } from '@queries/threads/insertThread';
import { listThreadsByUser } from '@queries/threads/listThreadsByUser';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

describe('listThreadsByUser', () => {
  const db = useTestDb();

  it('returns an empty list when the user has no threads', async () => {
    const threads = await listThreadsByUser(db, randomUUID());

    expect(threads).toEqual([]);
  });

  it('returns only threads belonging to the given user', async () => {
    const owner = randomUUID();
    const otherUser = randomUUID();
    await insertUserIfNotExists(db, owner);
    await insertUserIfNotExists(db, otherUser);

    await insertThread(db, { user_id: owner, title: 'Mine' });
    await insertThread(db, { user_id: otherUser, title: 'Not mine' });

    const threads = await listThreadsByUser(db, owner);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.title).toBe('Mine');
    expect(threads[0]?.user_id).toBe(owner);
  });

  it('orders threads newest first', async () => {
    const owner = randomUUID();
    await insertUserIfNotExists(db, owner);

    await insertThread(db, {
      user_id: owner,
      title: 'Old',
      created_at: new Date('2024-01-01T00:00:00.000Z'),
    });
    await insertThread(db, {
      user_id: owner,
      title: 'New',
      created_at: new Date('2024-06-01T00:00:00.000Z'),
    });

    const threads = await listThreadsByUser(db, owner);

    expect(threads.map((t) => t.title)).toEqual(['New', 'Old']);
  });

  it('breaks created_at ties deterministically by id desc', async () => {
    const owner = randomUUID();
    await insertUserIfNotExists(db, owner);
    const sameMoment = new Date('2024-03-15T12:00:00.000Z');

    const first = await insertThread(db, {
      user_id: owner,
      title: 'A',
      created_at: sameMoment,
    });
    const second = await insertThread(db, {
      user_id: owner,
      title: 'B',
      created_at: sameMoment,
    });

    const threads = await listThreadsByUser(db, owner);
    const ids = threads.map((t) => t.id);
    expect(ids).toEqual([first.id, second.id].sort((a, b) => b.localeCompare(a)));
  });
});

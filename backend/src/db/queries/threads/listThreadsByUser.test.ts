import { randomUUID } from 'node:crypto';
import { insertThread } from '@queries/threads/insertThread';
import { listThreadsByUser } from '@queries/threads/listThreadsByUser';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

describe('listThreadsByUser', () => {
  useTestDb();

  it('returns an empty list when the user has no threads', async () => {
    const threads = await listThreadsByUser({ userId: randomUUID() });

    expect(threads).toEqual([]);
  });

  it('returns only threads belonging to the given user', async () => {
    const owner = randomUUID();
    const otherUser = randomUUID();
    await insertUserIfNotExists({ id: owner });
    await insertUserIfNotExists({ id: otherUser });

    await insertThread({ userId: owner, title: 'Mine' });
    await insertThread({ userId: otherUser, title: 'Not mine' });

    const threads = await listThreadsByUser({ userId: owner });

    expect(threads).toHaveLength(1);
    expect(threads[0]?.title).toBe('Mine');
    expect(threads[0]?.userId).toBe(owner);
  });

  it('orders threads newest first', async () => {
    const owner = randomUUID();
    await insertUserIfNotExists({ id: owner });

    await insertThread({
      userId: owner,
      title: 'Old',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    await insertThread({
      userId: owner,
      title: 'New',
      createdAt: new Date('2024-06-01T00:00:00.000Z'),
    });

    const threads = await listThreadsByUser({ userId: owner });

    expect(threads.map((t) => t.title)).toEqual(['New', 'Old']);
  });

  it('breaks createdAt ties deterministically by id desc', async () => {
    const owner = randomUUID();
    await insertUserIfNotExists({ id: owner });
    const sameMoment = new Date('2024-03-15T12:00:00.000Z');

    const first = await insertThread({
      userId: owner,
      title: 'A',
      createdAt: sameMoment,
    });
    const second = await insertThread({
      userId: owner,
      title: 'B',
      createdAt: sameMoment,
    });

    const threads = await listThreadsByUser({ userId: owner });
    const ids = threads.map((t) => t.id);
    expect(ids).toEqual([first.id, second.id].sort((a, b) => b.localeCompare(a)));
  });
});

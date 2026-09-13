import { randomUUID } from 'node:crypto';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

describe('insertThread', () => {
  const db = useTestDb();

  it('inserts a thread and returns the full row with generated fields', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists(db, userId);

    const thread = await insertThread(db, { user_id: userId, title: 'First' });

    expect(thread.id).toBeTypeOf('string');
    expect(thread.id.length).toBeGreaterThan(0);
    expect(thread.user_id).toBe(userId);
    expect(thread.title).toBe('First');
    expect(thread.created_at).toBeInstanceOf(Date);
  });

  it('respects an explicitly provided created_at', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists(db, userId);
    const createdAt = new Date('2024-01-02T03:04:05.000Z');

    const thread = await insertThread(db, {
      user_id: userId,
      title: 'Old',
      created_at: createdAt,
    });

    expect(thread.created_at.getTime()).toBe(createdAt.getTime());
  });

  it('rejects when the user does not exist (FK violation)', async () => {
    await expect(
      insertThread(db, { user_id: randomUUID(), title: 'Orphan' }),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

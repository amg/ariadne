import { randomUUID } from 'node:crypto';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

describe('insertThread', () => {
  useTestDb();

  it('inserts a thread and returns the full row with generated fields', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });

    const thread = await insertThread({ userId: userId, title: 'First' });

    expect(thread.id).toBeTypeOf('string');
    expect(thread.id.length).toBeGreaterThan(0);
    expect(thread.userId).toBe(userId);
    expect(thread.title).toBe('First');
    expect(thread.createdAt).toBeInstanceOf(Date);
  });

  it('respects an explicitly provided createdAt', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const createdAt = new Date('2024-01-02T03:04:05.000Z');

    const thread = await insertThread({
      userId: userId,
      title: 'Old',
      createdAt: createdAt,
    });

    expect(thread.createdAt.getTime()).toBe(createdAt.getTime());
  });

  it('rejects when the user does not exist (FK violation)', async () => {
    await expect(insertThread({ userId: randomUUID(), title: 'Orphan' })).rejects.toMatchObject({
      code: '23503',
    });
  });
});

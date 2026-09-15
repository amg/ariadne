import { randomUUID } from 'node:crypto';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

describe('findThreadByIdAndUser', () => {
  useTestDb();

  it('returns the thread when the user owns it', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const thread = await insertThread({ userId: userId, title: 'Mine' });

    const found = await findThreadByIdAndUser({ userId, threadId: thread.id });

    expect(found?.id).toBe(thread.id);
    expect(found?.title).toBe('Mine');
  });

  it('returns undefined for another user thread', async () => {
    const owner = randomUUID();
    const stranger = randomUUID();
    await insertUserIfNotExists({ id: owner });
    await insertUserIfNotExists({ id: stranger });
    const thread = await insertThread({ userId: owner, title: 'Not yours' });

    const found = await findThreadByIdAndUser({ userId: stranger, threadId: thread.id });

    expect(found).toBeUndefined();
  });

  it('returns undefined for an unknown thread id', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });

    const found = await findThreadByIdAndUser({ userId, threadId: randomUUID() });

    expect(found).toBeUndefined();
  });
});

import { randomUUID } from 'node:crypto';
import type { NewMessage } from '@db/types';
import { insertMessage } from '@queries/messages/insertMessage';
import { listLiveMessagesByThread } from '@queries/messages/listLiveMessagesByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createRandomThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Test thread' });
  return thread.id;
}

/** Stores the rows one second apart, in the order given. */
async function storeInOrder(threadId: string, rows: Omit<NewMessage, 'threadId'>[]) {
  for (const [index, row] of rows.entries()) {
    const createdAt = new Date(Date.UTC(2026, 9, 29, 10, 0, index));
    await insertMessage({ ...row, threadId, createdAt });
  }
}

describe('listLiveMessagesByThread', () => {
  useTestDb();

  it('returns the Thread’s live Messages oldest first, without abandoned ones', async () => {
    const threadId = await createRandomThread();
    const otherThreadId = await createRandomThread();
    await storeInOrder(threadId, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'stale', abandoned: true },
      { role: 'assistant', content: 'fresh' },
      { role: 'user', content: 'edited away', abandoned: true },
    ]);
    await storeInOrder(otherThreadId, [{ role: 'user', content: 'not mine' }]);

    const rows = await listLiveMessagesByThread({ threadId });

    expect(rows.map((row) => row.content)).toEqual(['first', 'fresh']);
  });
});

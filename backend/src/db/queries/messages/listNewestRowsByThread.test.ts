import { randomUUID } from 'node:crypto';
import type { NewMessage } from '@db/types';
import { insertMessage } from '@queries/messages/insertMessage';
import { listNewestRowsByThread } from '@queries/messages/listNewestRowsByThread';
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
    await insertMessage({
      ...row,
      threadId,
      createdAt: new Date(Date.UTC(2026, 9, 29, 10, 0, index)),
    });
  }
}

const contentsOf = (rows: readonly { content: string }[]) => rows.map((row) => row.content);

describe('listNewestRowsByThread', () => {
  useTestDb();

  it('returns nothing for a Thread without Messages', async () => {
    const threadId = await createRandomThread();

    expect(await listNewestRowsByThread({ threadId })).toEqual([]);
  });

  it('returns the newest Turn alone, not the Turns before it', async () => {
    const threadId = await createRandomThread();
    await storeInOrder(threadId, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'second reply' },
    ]);

    const rows = await listNewestRowsByThread({ threadId });

    expect(contentsOf(rows)).toEqual(['second', 'second reply']);
  });

  it('starts at the newest reply when the newest arrival has no reply yet', async () => {
    const threadId = await createRandomThread();
    await storeInOrder(threadId, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'unanswered' },
    ]);

    const rows = await listNewestRowsByThread({ threadId });

    expect(contentsOf(rows)).toEqual(['first reply', 'unanswered']);
  });

  it('keeps every reply beneath the newest live arrival, abandoned ones included', async () => {
    const threadId = await createRandomThread();
    await storeInOrder(threadId, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'retried' },
      { role: 'assistant', content: 'stale reply', abandoned: true },
      { role: 'assistant', content: 'fresh reply' },
    ]);

    const rows = await listNewestRowsByThread({ threadId });

    expect(contentsOf(rows)).toEqual(['retried', 'stale reply', 'fresh reply']);
  });

  it('starts at the newest live arrival when an edit abandoned the arrivals after it', async () => {
    const threadId = await createRandomThread();
    await storeInOrder(threadId, [
      { role: 'user', content: 'kept' },
      { role: 'assistant', content: 'kept reply' },
      { role: 'user', content: 'edited away', abandoned: true },
    ]);

    const rows = await listNewestRowsByThread({ threadId });

    expect(contentsOf(rows)).toEqual(['kept', 'kept reply', 'edited away']);
  });

  it('reads only the given Thread', async () => {
    const threadId = await createRandomThread();
    const otherThreadId = await createRandomThread();
    await storeInOrder(threadId, [{ role: 'user', content: 'mine' }]);
    await storeInOrder(otherThreadId, [{ role: 'assistant', content: 'not mine' }]);

    const rows = await listNewestRowsByThread({ threadId });

    expect(contentsOf(rows)).toEqual(['mine']);
  });
});

import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import type { NewMessage } from '@db/types';
import { insertMessage } from '@queries/messages/insertMessage';
import { listModelHistoryByThread } from '@queries/messages/listModelHistoryByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

async function createRandomThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Test thread' });
  return thread.id;
}

/** Stores the rows one second apart, in the order given, and returns them. */
async function storeInOrder(threadId: string, rows: Omit<NewMessage, 'threadId'>[]) {
  const stored = [];
  for (const [index, row] of rows.entries()) {
    const createdAt = new Date(Date.UTC(2026, 9, 29, 10, 0, index));
    stored.push(await insertMessage({ ...row, threadId, createdAt }));
  }
  return stored;
}

describe('listModelHistoryByThread', () => {
  useTestDb();

  it('returns the live conversation before the Message, oldest first', async () => {
    const threadId = await createRandomThread();
    const [, , arrival] = await storeInOrder(threadId, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'the arrival' },
      { role: 'assistant', content: 'its reply' },
    ]);

    const history = await listModelHistoryByThread({
      threadId,
      beforeMessageId: arrival?.id ?? '',
    });

    expect(history).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first reply' },
    ]);
  });

  it('leaves out abandoned rows, empty replies and system rows', async () => {
    const threadId = await createRandomThread();
    const stored = await storeInOrder(threadId, [
      { role: 'system', content: 'a note' },
      { role: 'user', content: 'kept' },
      { role: 'assistant', content: 'stale', abandoned: true },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'edited away', abandoned: true },
      { role: 'user', content: 'the arrival' },
    ]);

    const history = await listModelHistoryByThread({
      threadId,
      beforeMessageId: stored.at(-1)?.id ?? '',
    });

    expect(history).toEqual([{ role: 'user', content: 'kept' }]);
  });

  it('keeps a reply stored in the same millisecond as the Message, just before it', async () => {
    const threadId = await createRandomThread();
    const [reply, arrival] = await storeInOrder(threadId, [
      { role: 'assistant', content: 'a moment before' },
      { role: 'user', content: 'the arrival' },
    ]);
    const stamp = async (id: string | undefined, at: string) =>
      db
        .updateTable('chat.messages')
        .set({ createdAt: sql<Date>`${at}::timestamptz` })
        .where('id', '=', id ?? '')
        .execute();
    await stamp(reply?.id, '2026-10-29 10:00:00.123400+00');
    await stamp(arrival?.id, '2026-10-29 10:00:00.123900+00');

    const history = await listModelHistoryByThread({
      threadId,
      beforeMessageId: arrival?.id ?? '',
    });

    expect(history).toEqual([{ role: 'assistant', content: 'a moment before' }]);
  });

  it('reads only the given Thread', async () => {
    const threadId = await createRandomThread();
    const otherThreadId = await createRandomThread();
    const [, arrival] = await storeInOrder(threadId, [
      { role: 'user', content: 'mine' },
      { role: 'user', content: 'the arrival' },
    ]);
    await storeInOrder(otherThreadId, [{ role: 'user', content: 'not mine' }]);

    const history = await listModelHistoryByThread({
      threadId,
      beforeMessageId: arrival?.id ?? '',
    });

    expect(history).toEqual([{ role: 'user', content: 'mine' }]);
  });
});

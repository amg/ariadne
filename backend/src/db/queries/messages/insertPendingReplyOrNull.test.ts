import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import { insertThread } from '@queries/threads/insertThread';
import { inTransaction } from '@queries/transaction/inTransaction';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';
import { insertPendingReplyOrNull } from './insertPendingReplyOrNull';
import { updateExchangeStatus } from './updateExchangeStatus';

useTestDb();

async function freshThreadId() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id } = await insertThread({ userId });
  return id;
}

describe('insertPendingReplyOrNull', () => {
  it('opens one pending reply per Thread, and another once the first settles', async () => {
    const threadId = await freshThreadId();

    const first = await insertPendingReplyOrNull({ threadId }, db);
    expect(first).toMatchObject({ threadId, role: 'assistant', exchangeStatus: 'pending' });
    expect(await insertPendingReplyOrNull({ threadId }, db)).toBeNull();

    await updateExchangeStatus({ messageId: first?.id ?? '', exchangeStatus: 'completed' });
    expect(await insertPendingReplyOrNull({ threadId }, db)).not.toBeNull();
  });

  it('lets other Threads open theirs', async () => {
    const one = await freshThreadId();
    const other = await freshThreadId();

    expect(await insertPendingReplyOrNull({ threadId: one }, db)).not.toBeNull();
    expect(await insertPendingReplyOrNull({ threadId: other }, db)).not.toBeNull();
  });

  it('decides a racing insert only once the first one commits', async () => {
    const threadId = await freshThreadId();
    let commitFirst: () => void = () => {};
    let firstInserted: () => void = () => {};
    const inserted = new Promise<void>((resolve) => {
      firstInserted = resolve;
    });

    const first = inTransaction(async (trx) => {
      const row = await insertPendingReplyOrNull({ threadId }, trx);
      firstInserted();
      await new Promise<void>((resolve) => {
        commitFirst = resolve;
      });
      return row;
    });
    await inserted;
    const second = inTransaction((trx) => insertPendingReplyOrNull({ threadId }, trx));
    commitFirst();

    expect(await first).not.toBeNull();
    expect(await second).toBeNull();
  });
});

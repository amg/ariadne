import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { insertThread } from '@queries/threads/insertThread';
import { moveArrivalToFreshThreadOrNull } from '@queries/threads/moveArrivalToFreshThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { someoneWaitsOnALock, useHeldTransactions } from '@test/locks';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

const EMPTY_SEED = { lines: [], factCount: 0 };

async function threadWithArrival(content: string) {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId, title: 'Handover' });
  const arrival = await insertMessage({ threadId, role: 'user', content });
  return { userId, threadId, arrival };
}

describe('moveArrivalToFreshThreadOrNull', () => {
  useTestDb();
  const openTransaction = useHeldTransactions();

  it('abandons the arrival and opens the fresh Thread with its copy', async () => {
    const { userId, threadId, arrival } = await threadWithArrival('Start over elsewhere');

    const moved = await moveArrivalToFreshThreadOrNull({
      userId,
      fromThreadId: threadId,
      messageId: arrival.id,
      seed: EMPTY_SEED,
    });

    expect(moved?.message.content).toBe('Start over elsewhere');
    const rows = await listMessagesByThread({ threadId });
    expect(rows.map((row) => row.abandoned)).toEqual([true]);
  });

  it('moves nothing when a reply started while the move waited on the arrival', async () => {
    const { userId, threadId, arrival } = await threadWithArrival('Continue or move?');
    const claim = await openTransaction();
    await claim.trx
      .selectFrom('chat.messages')
      .select('id')
      .where('id', '=', arrival.id)
      .forUpdate()
      .execute();
    await insertMessage(
      { threadId, role: 'assistant', content: '', exchangeStatus: 'pending' },
      claim.trx,
    );

    const moving = moveArrivalToFreshThreadOrNull({
      userId,
      fromThreadId: threadId,
      messageId: arrival.id,
      seed: EMPTY_SEED,
    });
    await someoneWaitsOnALock();
    await claim.commit();

    expect(await moving).toBeNull();
    const rows = await listMessagesByThread({ threadId });
    expect(rows.map((row) => [row.role, row.abandoned])).toEqual([
      ['user', false],
      ['assistant', false],
    ]);
  });
});

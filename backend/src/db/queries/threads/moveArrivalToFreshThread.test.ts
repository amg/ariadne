import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { insertThreadSegment } from '@queries/threadSegments/insertThreadSegment';
import { listThreadSegmentsByThread } from '@queries/threadSegments/listThreadSegmentsByThread';
import { insertThread } from '@queries/threads/insertThread';
import { moveArrivalToFreshThread } from '@queries/threads/moveArrivalToFreshThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { someoneWaitsOnALock, useHeldTransactions } from '@test/locks';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

const EMPTY_SEED = { lines: [], factCount: 0 };
const MODEL_ID = 'test-model';

async function threadWithArrival(content: string) {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId, title: 'Handover' });
  const arrival = await insertMessage({ threadId, role: 'user', content });
  return { userId, threadId, arrival };
}

describe('moveArrivalToFreshThread', () => {
  useTestDb();
  const openTransaction = useHeldTransactions();

  it('abandons the arrival and opens the fresh Thread with its copy', async () => {
    const { userId, threadId, arrival } = await threadWithArrival('Start over elsewhere');

    const moved = await moveArrivalToFreshThread({
      userId,
      fromThreadId: threadId,
      messageId: arrival.id,
      seed: EMPTY_SEED,
    });

    expect(moved?.message.content).toBe('Start over elsewhere');
    const rows = await listMessagesByThread({ threadId });
    expect(rows.map((row) => row.abandoned)).toEqual([true]);
  });

  it('deletes the segment the arrival opened in its old Thread', async () => {
    const { userId, threadId, arrival } = await threadWithArrival('A new topic');
    await insertThreadSegment({ threadId, startMessageId: arrival.id, modelId: MODEL_ID });

    await moveArrivalToFreshThread({
      userId,
      fromThreadId: threadId,
      messageId: arrival.id,
      seed: EMPTY_SEED,
    });

    expect(await listThreadSegmentsByThread({ threadId, modelId: MODEL_ID })).toEqual([]);
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

    const moving = moveArrivalToFreshThread({
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

import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import type { NewSegmentDriftLog } from '@db/types';
import { insertMessage } from '@queries/messages/insertMessage';
import { appendArrivalVerdict } from '@queries/segmentDriftLogs/appendArrivalVerdict';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { someoneWaitsOnALock, useHeldTransactions } from '@test/locks';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

const MODEL_ID = 'test/embed-model';

useTestDb();
const holdTransaction = useHeldTransactions();

/** A Thread whose opening segment is stored, and an arrival that fires out of it. */
async function chainWithFiringArrival() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId });
  const opening = await insertMessage({ threadId, role: 'user', content: 'Opening' });
  const openingSegment = {
    id: randomUUID(),
    threadId,
    startMessageId: opening.id,
    modelId: MODEL_ID,
  };
  expect(await appendArrivalVerdict({ openedSegments: [openingSegment], verdict: null })).toBe(
    true,
  );
  const arrival = await insertMessage({ threadId, role: 'user', content: 'Something else' });
  const verdict: NewSegmentDriftLog = {
    segmentId: openingSegment.id,
    messageId: arrival.id,
    modelId: MODEL_ID,
    verdict: 'fire',
    fireChannel: 'immediate',
  };
  const fire = {
    openedSegments: [{ id: randomUUID(), threadId, startMessageId: arrival.id, modelId: MODEL_ID }],
    verdict,
  };
  return { threadId, openingSegmentId: openingSegment.id, arrivalId: arrival.id, fire };
}

async function chainOf(threadId: string) {
  const [segments, logs] = await Promise.all([
    db
      .selectFrom('analysis.threadSegments')
      .select(['id', 'startMessageId'])
      .where('threadId', '=', threadId)
      .execute(),
    db
      .selectFrom('analysis.segmentDriftLogs as l')
      .innerJoin('analysis.threadSegments as s', 's.id', 'l.segmentId')
      .select(['l.messageId', 'l.segmentId'])
      .where('s.threadId', '=', threadId)
      .execute(),
  ]);
  return { segments, logs };
}

describe('appendArrivalVerdict', () => {
  it("stores the verdict with the segment the arrival's fire opens", async () => {
    const { threadId, openingSegmentId, arrivalId, fire } = await chainWithFiringArrival();

    expect(await appendArrivalVerdict(fire)).toBe(true);

    const { segments, logs } = await chainOf(threadId);
    expect(segments.map((segment) => segment.startMessageId)).toContain(arrivalId);
    expect(logs).toEqual([{ messageId: arrivalId, segmentId: openingSegmentId }]);
  });

  it('writes nothing when the verdict is already logged, not even the segment', async () => {
    const { threadId, fire } = await chainWithFiringArrival();
    await appendArrivalVerdict({ openedSegments: [], verdict: fire.verdict });
    const before = await chainOf(threadId);

    expect(await appendArrivalVerdict(fire)).toBe(false);

    expect(await chainOf(threadId)).toEqual(before);
  });

  it('writes nothing when the segment is already opened, not even the verdict', async () => {
    const { threadId, fire } = await chainWithFiringArrival();
    const opened = fire.openedSegments.map((segment) => ({ ...segment, id: randomUUID() }));
    await appendArrivalVerdict({ openedSegments: opened, verdict: null });
    const before = await chainOf(threadId);

    expect(await appendArrivalVerdict(fire)).toBe(false);

    expect(await chainOf(threadId)).toEqual(before);
  });

  it('waits for a pass still committing the same verdict, then reports it lost', async () => {
    const { threadId, fire } = await chainWithFiringArrival();
    const other = await holdTransaction();
    await other.trx
      .insertInto('analysis.segmentDriftLogs')
      .values({ ...fire.verdict, verdict: 'pass', fireChannel: null })
      .execute();

    const appending = appendArrivalVerdict(fire);
    await someoneWaitsOnALock();
    await other.commit();

    expect(await appending).toBe(false);
    const { segments, logs } = await chainOf(threadId);
    expect(segments).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });
});

import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import type { NewArrivalJudgmentState, NewSegmentDriftLog } from '@db/types';
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
  const reply = await insertMessage({ threadId, role: 'assistant', content: 'Opening reply' });
  expect(
    await appendArrivalVerdict({
      threadId,
      openedSegments: [openingSegment],
      verdict: null,
      judgmentState: null,
      keep: { stateMessageIds: [], foldMessageIds: [] },
    }),
  ).toBe(true);
  const arrival = await insertMessage({ threadId, role: 'user', content: 'Something else' });
  const verdict: NewSegmentDriftLog = {
    segmentId: openingSegment.id,
    messageId: arrival.id,
    modelId: MODEL_ID,
    verdict: 'fire',
    fireChannel: 'immediate',
  };
  const fire = {
    threadId,
    openedSegments: [{ id: randomUUID(), threadId, startMessageId: arrival.id, modelId: MODEL_ID }],
    verdict,
  };
  return {
    threadId,
    openingSegmentId: openingSegment.id,
    arrivalId: arrival.id,
    openingReplyId: reply.id,
    fire,
  };
}

/** A zero state: nothing accepted yet, the patrol empty. */
function freshState(messageId: string): NewArrivalJudgmentState {
  return {
    messageId,
    modelId: MODEL_ID,
    baselineCount: 0,
    baselineMean: 0,
    baselineM2: 0,
    patrolCount: 0,
    patrolSum: 0,
    patrolCumulative: 0,
    patrolLowWater: 0,
    patrolLowWaterMessageId: null,
  };
}

/** Keeps only this arrival's own checkpoints — the keep-two rule for the Thread's first arrival. */
function keepOwn(arrivalId: string, replyId?: string) {
  return {
    stateMessageIds: [arrivalId],
    foldMessageIds: replyId === undefined ? [] : [replyId],
  };
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

async function statesOf(threadId: string) {
  const rows = await db
    .selectFrom('analysis.arrivalJudgmentStates as s')
    .innerJoin('chat.messages as m', 'm.id', 's.messageId')
    .where('m.threadId', '=', threadId)
    .select('s.messageId')
    .execute();
  return rows.map((row) => row.messageId);
}

describe('appendArrivalVerdict', () => {
  it("stores the verdict with the segment the arrival's fire opens", async () => {
    const { threadId, openingSegmentId, arrivalId, fire } = await chainWithFiringArrival();

    expect(
      await appendArrivalVerdict({ ...fire, judgmentState: null, keep: keepOwn(arrivalId) }),
    ).toBe(true);

    const { segments, logs } = await chainOf(threadId);
    expect(segments.map((segment) => segment.startMessageId)).toContain(arrivalId);
    expect(logs).toEqual([{ messageId: arrivalId, segmentId: openingSegmentId }]);
  });

  it('stores the judgment state with the verdict', async () => {
    const { threadId, arrivalId, fire } = await chainWithFiringArrival();
    const state = {
      ...freshState(arrivalId),
      baselineCount: 3,
      baselineMean: 0.25,
      baselineM2: 0.01,
      patrolCount: 3,
      patrolSum: 0.75,
      patrolCumulative: -0.02,
      patrolLowWater: -0.05,
      patrolLowWaterMessageId: arrivalId,
    };

    expect(
      await appendArrivalVerdict({ ...fire, judgmentState: state, keep: keepOwn(arrivalId) }),
    ).toBe(true);

    const stored = await db
      .selectFrom('analysis.arrivalJudgmentStates')
      .selectAll()
      .where('messageId', '=', arrivalId)
      .where('modelId', '=', MODEL_ID)
      .executeTakeFirstOrThrow();
    expect(stored.baselineCount).toBe(3);
    expect(stored.baselineMean).toBe(0.25);
    expect(stored.patrolLowWaterMessageId).toBe(arrivalId);
    expect(await statesOf(threadId)).toEqual([arrivalId]);
  });

  it('prunes the Thread\u2019s other checkpoints to the keep-two survivors', async () => {
    const { threadId, arrivalId, fire } = await chainWithFiringArrival();
    // An older arrival's checkpoint, kept by an earlier commit's keep-two.
    const stale = await insertMessage({ threadId, role: 'user', content: 'Long gone' });
    const staleSegment = {
      id: randomUUID(),
      threadId,
      startMessageId: stale.id,
      modelId: MODEL_ID,
    };
    await db
      .insertInto('analysis.threadSegments')
      .values(staleSegment)
      .onConflict((oc) => oc.columns(['threadId', 'startMessageId', 'modelId']).doNothing())
      .execute();
    await db
      .insertInto('analysis.segmentDriftLogs')
      .values({
        segmentId: staleSegment.id,
        messageId: stale.id,
        modelId: MODEL_ID,
        verdict: 'pass',
      })
      .execute();
    await db
      .insertInto('analysis.arrivalJudgmentStates')
      .values(freshState(stale.id))
      .onConflict((oc) => oc.columns(['messageId', 'modelId']).doNothing())
      .execute();

    expect(
      await appendArrivalVerdict({
        ...fire,
        judgmentState: freshState(arrivalId),
        keep: keepOwn(arrivalId),
      }),
    ).toBe(true);

    // The stale checkpoint left the live keep-two; the abandoned-free
    // Thread keeps only the newest arrival's state.
    expect(await statesOf(threadId)).toEqual([arrivalId]);
  });

  it('keeps the checkpoints of abandoned arrivals while pruning the live ones', async () => {
    const { threadId, arrivalId, fire } = await chainWithFiringArrival();
    // An abandoned arrival keeps its checkpoint whatever the keep-two rule prunes.
    const abandoned = await insertMessage({ threadId, role: 'user', content: 'Edited away' });
    const abandonedSegment = {
      id: randomUUID(),
      threadId,
      startMessageId: abandoned.id,
      modelId: MODEL_ID,
    };
    await db
      .insertInto('analysis.threadSegments')
      .values(abandonedSegment)
      .onConflict((oc) => oc.columns(['threadId', 'startMessageId', 'modelId']).doNothing())
      .execute();
    await db
      .insertInto('analysis.segmentDriftLogs')
      .values({
        segmentId: abandonedSegment.id,
        messageId: abandoned.id,
        modelId: MODEL_ID,
        verdict: 'pass',
      })
      .execute();
    await db
      .updateTable('chat.messages')
      .set({ abandoned: true })
      .where('id', '=', abandoned.id)
      .execute();
    await db
      .insertInto('analysis.arrivalJudgmentStates')
      .values(freshState(abandoned.id))
      .onConflict((oc) => oc.columns(['messageId', 'modelId']).doNothing())
      .execute();

    expect(
      await appendArrivalVerdict({
        ...fire,
        judgmentState: freshState(arrivalId),
        keep: keepOwn(arrivalId),
      }),
    ).toBe(true);

    expect(await statesOf(threadId)).toEqual([abandoned.id, arrivalId]);
  });

  it('writes nothing when the verdict is already logged, not even the segment', async () => {
    const { threadId, fire } = await chainWithFiringArrival();
    await appendArrivalVerdict({
      ...fire,
      openedSegments: [],
      judgmentState: null,
      keep: keepOwn(fire.verdict.messageId),
    });
    const before = await chainOf(threadId);

    expect(
      await appendArrivalVerdict({
        ...fire,
        judgmentState: null,
        keep: keepOwn(fire.verdict.messageId),
      }),
    ).toBe(false);

    expect(await chainOf(threadId)).toEqual(before);
  });

  it('writes nothing when the segment is already opened, not even the verdict', async () => {
    const { threadId, fire } = await chainWithFiringArrival();
    const opened = fire.openedSegments.map((segment) => ({ ...segment, id: randomUUID() }));
    await appendArrivalVerdict({
      threadId,
      openedSegments: opened,
      verdict: null,
      judgmentState: null,
      keep: keepOwn(fire.verdict.messageId),
    });
    const before = await chainOf(threadId);

    expect(
      await appendArrivalVerdict({
        ...fire,
        judgmentState: null,
        keep: keepOwn(fire.verdict.messageId),
      }),
    ).toBe(false);

    expect(await chainOf(threadId)).toEqual(before);
  });

  it('waits for a pass still committing the same verdict, then reports it lost', async () => {
    const { threadId, fire } = await chainWithFiringArrival();
    const other = await holdTransaction();
    await other.trx
      .insertInto('analysis.segmentDriftLogs')
      .values({ ...fire.verdict, verdict: 'pass', fireChannel: null })
      .execute();

    const appending = appendArrivalVerdict({
      ...fire,
      judgmentState: null,
      keep: keepOwn(fire.verdict.messageId),
    });
    await someoneWaitsOnALock();
    await other.commit();

    expect(await appending).toBe(false);
    const { segments, logs } = await chainOf(threadId);
    expect(segments).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });
});

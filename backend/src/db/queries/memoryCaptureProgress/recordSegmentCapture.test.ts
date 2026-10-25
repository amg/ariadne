import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import type { NewUserFact } from '@db/types';
import { recordSegmentCapture } from '@queries/memoryCaptureProgress/recordSegmentCapture';
import {
  captureProgressOf,
  upsertCaptureProgress,
} from '@queries/memoryCaptureProgress/upsertCaptureProgress';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThreadSegment } from '@queries/threadSegments/insertThreadSegment';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserFact } from '@queries/userFacts/insertUserFact';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { someoneWaitsOnALock, useHeldTransactions } from '@test/locks';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

type CapturedFact = Parameters<typeof recordSegmentCapture>[0]['facts'][number];

useTestDb();
const holdTransaction = useHeldTransactions();

const EARLIER = new Date('2026-10-01T10:00:00Z');
const LATER = new Date('2026-10-02T10:00:00Z');

async function userWithSegment() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId });
  const opening = await insertMessage({ threadId, role: 'user', content: 'I love jazz' });
  const segment = await insertThreadSegment({
    threadId,
    startMessageId: opening.id,
    modelId: 'test/embed-model',
  });
  return { userId, segmentId: segment.id };
}

function factRow(userId: string, content: string): NewUserFact {
  return {
    userId,
    content,
    category: 'preference',
    subject: 'user',
    predicate: null,
    object: null,
    embedding: new Array<number>(1024).fill(0.01),
    modelId: 'test/embed-model',
    sourceMessageId: null,
    validAt: null,
  };
}

function newFact(
  userId: string,
  content: string,
  replacesFactId: string | null = null,
): CapturedFact {
  return { id: randomUUID(), row: factRow(userId, content), replacesFactId };
}

/** The user's Fact rows, current and superseded, by content. */
async function factsOf(userId: string) {
  const rows = await db
    .selectFrom('memory.userFacts')
    .select(['content', 'invalidAt'])
    .where('userId', '=', userId)
    .execute();
  return rows.sort((a, b) => (a.content < b.content ? -1 : 1));
}

describe('recordSegmentCapture', () => {
  it("stores a first capture's Facts and starts the pointer", async () => {
    const { userId, segmentId } = await userWithSegment();

    const stored = await recordSegmentCapture({
      segmentId,
      readFrom: null,
      throughAt: EARLIER,
      facts: [newFact(userId, 'The user loves jazz.')],
    });

    expect(stored).toBe(true);
    expect(await factsOf(userId)).toEqual([{ content: 'The user loves jazz.', invalidAt: null }]);
    expect(await captureProgressOf(segmentId)).toEqual(EARLIER);
  });

  it('stores a later Fact of the same capture in place of an earlier one', async () => {
    const { userId, segmentId } = await userWithSegment();
    const first = newFact(userId, 'The user loves jazz.');
    const restated = newFact(userId, 'The user loves jazz a lot.', first.id);

    await recordSegmentCapture({
      segmentId,
      readFrom: null,
      throughAt: EARLIER,
      facts: [first, restated],
    });

    expect(await factsOf(userId)).toEqual([
      { content: 'The user loves jazz a lot.', invalidAt: null },
      { content: 'The user loves jazz.', invalidAt: expect.any(Date) },
    ]);
  });

  it('drops a replacement whose Fact was superseded meanwhile, keeping the rest', async () => {
    const { userId, segmentId } = await userWithSegment();
    const known = await insertUserFact(factRow(userId, 'The user likes rock.'));
    await db
      .updateTable('memory.userFacts')
      .set({ invalidAt: new Date() })
      .where('id', '=', known.id)
      .execute();

    await recordSegmentCapture({
      segmentId,
      readFrom: null,
      throughAt: EARLIER,
      facts: [
        newFact(userId, 'The user loves rock.', known.id),
        newFact(userId, 'The user loves jazz.'),
      ],
    });

    expect((await factsOf(userId)).filter((fact) => fact.invalidAt === null)).toEqual([
      { content: 'The user loves jazz.', invalidAt: null },
    ]);
  });

  it('stores nothing once another pass moved the pointer the capture read', async () => {
    const { userId, segmentId } = await userWithSegment();
    await upsertCaptureProgress({ segmentId, throughAt: LATER });

    const fromEarlier = await recordSegmentCapture({
      segmentId,
      readFrom: EARLIER,
      throughAt: LATER,
      facts: [newFact(userId, 'The user loves jazz.')],
    });
    const fromNothing = await recordSegmentCapture({
      segmentId,
      readFrom: null,
      throughAt: LATER,
      facts: [newFact(userId, 'The user loves rock.')],
    });

    expect([fromEarlier, fromNothing]).toEqual([false, false]);
    expect(await factsOf(userId)).toEqual([]);
    expect(await captureProgressOf(segmentId)).toEqual(LATER);
  });

  it('waits for a capture still committing from the same pointer, then stores nothing', async () => {
    const { userId, segmentId } = await userWithSegment();
    await upsertCaptureProgress({ segmentId, throughAt: EARLIER });
    const other = await holdTransaction();
    await other.trx
      .updateTable('memory.memoryCaptureProgress')
      .set({ capturedThroughAt: LATER })
      .where('segmentId', '=', segmentId)
      .execute();

    const recording = recordSegmentCapture({
      segmentId,
      readFrom: EARLIER,
      throughAt: LATER,
      facts: [newFact(userId, 'The user loves jazz.')],
    });
    await someoneWaitsOnALock();
    await other.commit();

    expect(await recording).toBe(false);
    expect(await factsOf(userId)).toEqual([]);
  });
});

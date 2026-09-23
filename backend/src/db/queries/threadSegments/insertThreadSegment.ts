import { db } from '@db/db';
import type { NewThreadSegment, ThreadSegment } from '@db/types';

/**
 * Opens a live-chain segment: one row naming the user Message that starts
 * it. The chain's chronology implies every segment's end (the next
 * segment's start), so nothing else is stored.
 */
export async function insertThreadSegment(row: NewThreadSegment): Promise<ThreadSegment> {
  const inserted = await db
    .insertInto('threadSegments')
    .values({ threadId: row.threadId, startMessageId: row.startMessageId })
    .returningAll()
    .executeTakeFirstOrThrow();
  return inserted;
}

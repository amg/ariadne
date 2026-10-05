import { db } from '@db/db';
import { sql } from 'kysely';

/** Records that a segment's Fact capture settled. Idempotent. */
export async function markSegmentFactsCaptured({
  segmentId,
}: { segmentId: string }): Promise<void> {
  await db
    .updateTable('threadSegments')
    .set({ factsCapturedAt: sql`now()` })
    .where('id', '=', segmentId)
    .where('factsCapturedAt', 'is', null)
    .execute();
}

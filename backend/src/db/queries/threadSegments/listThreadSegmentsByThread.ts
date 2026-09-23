import { db } from '@db/db';
import type { ThreadSegment } from '@db/types';

type ListThreadSegmentsByThreadProps = {
  threadId: string;
};

/** The live arrival chain for a thread, oldest segment first. */
export async function listThreadSegmentsByThread({
  threadId,
}: ListThreadSegmentsByThreadProps): Promise<ThreadSegment[]> {
  return db
    .selectFrom('threadSegments')
    .selectAll()
    .where('threadId', '=', threadId)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

import { db } from '@db/db';

/**
 * The capture pointers of the given segments: segments capture has never
 * reached are absent. Owed rows there keep their maybe-unwritten pointer
 * null.
 */
export async function capturePointersOf(segmentIds: string[]) {
  if (segmentIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('memory.memoryCaptureProgress')
    .select(['segmentId', 'capturedThroughAt'])
    .where('segmentId', 'in', segmentIds)
    .execute();
  return new Map(rows.map((row) => [row.segmentId, row.capturedThroughAt]));
}

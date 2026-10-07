import { db } from '@db/db';
import type { ThreadSegment } from '@db/types';

type ListThreadSegmentsByThreadProps = {
  threadId: string;
  /** Which model's chain to read — one chain per embedding model runs. */
  modelId: string;
};

/** A thread's live arrival chain under one embedding model, oldest first. */
export async function listThreadSegmentsByThread({
  threadId,
  modelId,
}: ListThreadSegmentsByThreadProps): Promise<ThreadSegment[]> {
  return db
    .selectFrom('analysis.threadSegments')
    .selectAll()
    .where('threadId', '=', threadId)
    .where('modelId', '=', modelId)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

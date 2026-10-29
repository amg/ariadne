import { db } from '@db/db';
import type { DbExecutor } from '@db/types';

/** Deletes the segments any of the given Messages opened. The Messages themselves stay. */
export async function deleteSegmentsOpenedBy(
  { messageIds }: { messageIds: readonly string[] },
  executor: DbExecutor = db,
) {
  if (messageIds.length === 0) return;
  await executor
    .deleteFrom('analysis.threadSegments')
    .where('startMessageId', 'in', messageIds)
    .execute();
}

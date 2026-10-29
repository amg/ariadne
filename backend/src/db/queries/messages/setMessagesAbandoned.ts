import { db } from '@db/db';
import type { DbExecutor } from '@db/types';
import { deleteSegmentsOpenedBy } from '@queries/threadSegments/deleteSegmentsOpenedBy';

/**
 * Flags rows as abandoned or live: an edit abandons the turn it replaces,
 * and a retry the stale replies it overruns. Abandoned rows stay, so
 * their text, analysis and usage still show what the thread spent. Listing,
 * drafting, inference and reporting skip them. A segment that starts at
 * an abandoned row is deleted, because the conversation no longer runs
 * through it. Idempotent in both directions.
 */
export async function setMessagesAbandoned(
  {
    messageIds,
    abandoned,
  }: {
    messageIds: readonly string[];
    abandoned: boolean;
  },
  executor: DbExecutor = db,
) {
  if (messageIds.length === 0) return;
  await executor
    .updateTable('chat.messages')
    .set({ abandoned })
    .where('id', 'in', messageIds)
    .execute();
  if (abandoned) await deleteSegmentsOpenedBy({ messageIds }, executor);
}

import { db } from '@db/db';

/**
 * Flags rows as abandoned or live: an edit abandons the turn it replaces,
 * a retry the stale replies it overruns, and a handover the arrival it
 * moves to a fresh Thread.
 * Abandoned rows stay — text, arrival analysis and usage keep tracking
 * what the thread burned — only listing, drafting, inference and reporting
 * skip them. Idempotent in both directions.
 */
export async function setMessagesAbandoned({
  messageIds,
  abandoned,
}: {
  messageIds: string[];
  abandoned: boolean;
}): Promise<void> {
  if (messageIds.length === 0) return;
  await db.updateTable('messages').set({ abandoned }).where('id', 'in', messageIds).execute();
}

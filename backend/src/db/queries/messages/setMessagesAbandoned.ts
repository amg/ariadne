import { db } from '@db/db';

/**
 * Flags a row's exchange state: an exchange that ends without completing
 * abandons its arrival and its assistant row, and an edit abandons the old
 * turn it replaces; a retry revives the abandoned turn it re-exchanges.
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

import { db } from '@db/db';

/**
 * Flags an exchange's arrival row abandoned: set by the exchange when it
 * ends without completing, so the arrival shows up in the thread (partial
 * title, resume draft) instead of being swallowed. Idempotent.
 */
export async function markMessageAbandoned({
  messageId,
}: {
  messageId: string;
}): Promise<void> {
  await db.updateTable('messages').set({ abandoned: true }).where('id', '=', messageId).execute();
}

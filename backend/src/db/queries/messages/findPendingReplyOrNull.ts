import { db } from '@db/db';

/** The Thread's reply still marked `pending`, or null when none is. */
export async function findPendingReplyOrNull({ threadId }: { threadId: string }) {
  const row = await db
    .selectFrom('chat.messages')
    .selectAll()
    .where('threadId', '=', threadId)
    .where('exchangeStatus', '=', 'pending')
    .executeTakeFirst();
  return row ?? null;
}

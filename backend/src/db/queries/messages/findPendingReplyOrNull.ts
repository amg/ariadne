import { db } from '@db/db';
import type { Message } from '@db/types';

/** The Thread's reply still marked `pending`, or null when none is. */
export async function findPendingReplyOrNull({
  threadId,
}: {
  threadId: string;
}): Promise<Message | null> {
  const row = await db
    .selectFrom('chat.messages')
    .selectAll()
    .where('threadId', '=', threadId)
    .where('exchangeStatus', '=', 'pending')
    .executeTakeFirst();
  return row ?? null;
}

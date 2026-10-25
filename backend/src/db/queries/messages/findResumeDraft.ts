import { db } from '@db/db';

/**
 * The resume draft of a thread: the newest user row's text when that row
 * is abandoned and no exchange completed after it. A handed-over arrival
 * owes nothing here: it lives on in its fresh Thread.
 */
export async function findResumeDraft({
  threadId,
}: {
  threadId: string;
}) {
  const newestUser = await db
    .selectFrom('chat.messages')
    .select(['id', 'content', 'abandoned', 'createdAt'])
    .where('threadId', '=', threadId)
    .where('role', '=', 'user')
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!newestUser || !newestUser.abandoned) return undefined;

  const handedOver = await db
    .selectFrom('memory.threadSeeds')
    .select('threadId')
    .where('handoverMessageId', '=', newestUser.id)
    .executeTakeFirst();
  if (handedOver) return undefined;

  const completedAfter = await db
    .selectFrom('chat.messages')
    .select('id')
    .where('threadId', '=', threadId)
    .where('role', '=', 'assistant')
    .where('exchangeStatus', '=', 'completed')
    .where('createdAt', '>', newestUser.createdAt)
    .limit(1)
    .executeTakeFirst();
  if (completedAfter) return undefined;

  return { messageId: newestUser.id, content: newestUser.content };
}

import { db } from '@db/db';

export type ResumeDraft = {
  messageId: string;
  content: string;
};

/**
 * The resume draft of a thread: the newest user row's text when that
 * arrival was abandoned and the exchange was never completed afterwards —
 * interrupted/failed exchanges hand their text back to the input; a
 * completed exchange has already settled the draft.
 */
export async function findResumeDraft({
  threadId,
}: {
  threadId: string;
}): Promise<ResumeDraft | undefined> {
  const newestUser = await db
    .selectFrom('messages')
    .select(['id', 'content', 'abandoned', 'createdAt'])
    .where('threadId', '=', threadId)
    .where('role', '=', 'user')
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!newestUser || !newestUser.abandoned) return undefined;

  const completedAfter = await db
    .selectFrom('messages')
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

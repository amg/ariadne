import { db } from '@db/db';

type IsLiveArrivalProps = {
  userId: string;
  threadId: string;
  messageId: string;
};

/**
 * True when the Message is a user Message, not abandoned, in the Thread,
 * and the Thread belongs to the user. Deleted, abandoned, foreign and
 * unknown Messages all read false.
 */
export async function isLiveArrival({
  userId,
  threadId,
  messageId,
}: IsLiveArrivalProps): Promise<boolean> {
  const row = await db
    .selectFrom('chat.messages as msg')
    .innerJoin('chat.threads as thread', 'thread.id', 'msg.threadId')
    .select('msg.id')
    .where('msg.id', '=', messageId)
    .where('msg.threadId', '=', threadId)
    .where('thread.userId', '=', userId)
    .where('msg.role', '=', 'user')
    .where('msg.abandoned', '=', false)
    .executeTakeFirst();
  return row !== undefined;
}

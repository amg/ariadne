import { db } from '@db/db';
import { tagQuery } from '@db/queryTag';

/**
 * The user Message a reply answers: the newest user Message stored before
 * it, abandoned or not. Null when the reply has none above it.
 */
export async function findPromptOfReplyOrNull({
  threadId,
  replyId,
}: {
  threadId: string;
  replyId: string;
}) {
  const row = await db
    .withPlugin(tagQuery('messages/findPromptOfReplyOrNull'))
    .selectFrom('chat.messages')
    .selectAll()
    .where('threadId', '=', threadId)
    .where('role', '=', 'user')
    .where((eb) =>
      eb(
        'createdAt',
        '<',
        eb
          .selectFrom('chat.messages')
          .select('createdAt')
          .where('id', '=', replyId)
          .where('threadId', '=', threadId),
      ),
    )
    .orderBy('createdAt', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

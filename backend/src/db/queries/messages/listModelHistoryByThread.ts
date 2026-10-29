import { db } from '@db/db';
import { tagQuery } from '@db/queryTag';

/**
 * The Thread's conversation before one of its Messages, as the model reads
 * it: user Messages and non-empty replies that are not abandoned, oldest
 * first, with their role and text alone.
 */
export async function listModelHistoryByThread({
  threadId,
  beforeMessageId,
}: {
  threadId: string;
  beforeMessageId: string;
}) {
  return db
    .withPlugin(tagQuery('messages/listModelHistoryByThread'))
    .selectFrom('chat.messages')
    .select(['role', 'content'])
    .where('threadId', '=', threadId)
    .where('abandoned', '=', false)
    .where((eb) =>
      eb(
        'createdAt',
        '<',
        eb
          .selectFrom('chat.messages')
          .select('createdAt')
          .where('id', '=', beforeMessageId)
          .where('threadId', '=', threadId),
      ),
    )
    .where((eb) =>
      eb.or([
        eb('role', '=', 'user'),
        eb.and([eb('role', '=', 'assistant'), eb('content', '!=', '')]),
      ]),
    )
    .orderBy('createdAt', 'asc')
    .execute();
}

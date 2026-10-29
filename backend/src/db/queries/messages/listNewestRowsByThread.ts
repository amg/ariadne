import { db } from '@db/db';
import { tagQuery } from '@db/queryTag';
import type { DbExecutor } from '@db/types';

/**
 * The Thread's newest rows, oldest first: every row from its newest
 * assistant Message or its newest live user Message, whichever came
 * first, to the end. That holds the newest live user Message with every
 * reply beneath it, the newest reply and the newest live row. Empty when
 * the Thread has neither.
 */
export async function listNewestRowsByThread(
  { threadId }: { threadId: string },
  executor: DbExecutor = db,
) {
  const tagged = executor.withPlugin(tagQuery('messages/listNewestRowsByThread'));
  const newestReplyAt = tagged
    .selectFrom('chat.messages')
    .select((eb) => eb.fn.max('createdAt').as('createdAt'))
    .where('threadId', '=', threadId)
    .where('role', '=', 'assistant');
  const newestLiveArrivalAt = tagged
    .selectFrom('chat.messages')
    .select((eb) => eb.fn.max('createdAt').as('createdAt'))
    .where('threadId', '=', threadId)
    .where('role', '=', 'user')
    .where('abandoned', '=', false);
  return tagged
    .selectFrom('chat.messages')
    .selectAll()
    .where('threadId', '=', threadId)
    .where((eb) =>
      eb('createdAt', '>=', eb.fn<Date>('least', [newestReplyAt, newestLiveArrivalAt])),
    )
    .orderBy('createdAt', 'asc')
    .execute();
}

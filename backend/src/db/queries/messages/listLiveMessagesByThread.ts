import { db } from '@db/db';
import { tagQuery } from '@db/queryTag';

/** The Thread's Messages that are not abandoned, oldest first. */
export async function listLiveMessagesByThread({ threadId }: { threadId: string }) {
  return db
    .withPlugin(tagQuery('messages/listLiveMessagesByThread'))
    .selectFrom('chat.messages')
    .selectAll()
    .where('threadId', '=', threadId)
    .where('abandoned', '=', false)
    .orderBy('createdAt', 'asc')
    .execute();
}

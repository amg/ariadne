import { db } from '@db/db';

type ListUnansweredArrivalsByUserProps = {
  userId: string;
};

/**
 * Each of the user's Threads whose newest live row is a user Message, with
 * that Message; Threads ending in a reply are left out. Newest Thread
 * first, like the thread list. One query, whatever the user's history.
 */
export async function listUnansweredArrivalsByUser({ userId }: ListUnansweredArrivalsByUserProps) {
  return db
    .selectFrom((eb) =>
      eb
        .selectFrom('chat.messages')
        .innerJoin('chat.threads', 'chat.threads.id', 'chat.messages.threadId')
        .where('chat.threads.userId', '=', userId)
        .where('chat.messages.abandoned', '=', false)
        .distinctOn('chat.messages.threadId')
        .select([
          'chat.messages.threadId as threadId',
          'chat.messages.id as messageId',
          'chat.messages.role as role',
          'chat.threads.createdAt as threadCreatedAt',
        ])
        .orderBy('chat.messages.threadId')
        .orderBy('chat.messages.createdAt', 'desc')
        .orderBy('chat.messages.id', 'desc')
        .as('newest'),
    )
    .where('newest.role', '=', 'user')
    .select(['newest.threadId', 'newest.messageId'])
    .orderBy('newest.threadCreatedAt', 'desc')
    .orderBy('newest.threadId', 'desc')
    .execute();
}

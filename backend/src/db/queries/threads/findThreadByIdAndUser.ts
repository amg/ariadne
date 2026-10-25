import { db } from '@db/db';

type FindThreadByIdAndUserProps = {
  userId: string;
  threadId: string;
};

/**
 * Ownership check for a thread. Returns the row only when it belongs to the
 * user; unknown ids and foreign threads are indistinguishable (both
 * undefined), so callers can 404 without leaking existence.
 */
export async function findThreadByIdAndUser({ userId, threadId }: FindThreadByIdAndUserProps) {
  return db
    .selectFrom('chat.threads')
    .selectAll()
    .where('id', '=', threadId)
    .where('userId', '=', userId)
    .executeTakeFirst();
}

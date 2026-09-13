import { db } from '@db/db';
import type { Thread } from '@db/types';

/**
 * Ownership check for a thread. Returns the row only when it belongs to the
 * user; unknown ids and foreign threads are indistinguishable (both
 * undefined), so callers can 404 without leaking existence.
 */
export async function findThreadByIdAndUser(
  userId: string,
  threadId: string,
): Promise<Thread | undefined> {
  return db
    .selectFrom('threads')
    .selectAll()
    .where('id', '=', threadId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
}

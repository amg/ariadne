import type { Database, Thread } from '@db/types';
import type { Kysely } from 'kysely';

/**
 * Renames a thread owned by the user. Returns the updated row, or undefined
 * when the thread is unknown or belongs to someone else (no information
 * leakage either way).
 */
export async function updateThreadTitle(
  db: Kysely<Database>,
  userId: string,
  threadId: string,
  title: string,
): Promise<Thread | undefined> {
  return db
    .updateTable('threads')
    .set({ title })
    .where('id', '=', threadId)
    .where('user_id', '=', userId)
    .returningAll()
    .executeTakeFirst();
}

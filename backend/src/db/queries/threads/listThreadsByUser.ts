import type { Database, Thread } from '@db/types';
import type { Kysely } from 'kysely';

/**
 * Threads owned by a user, newest first. `id` desc is a deterministic
 * tie-breaker for rows sharing the same `created_at`.
 */
export async function listThreadsByUser(db: Kysely<Database>, userId: string): Promise<Thread[]> {
  return db
    .selectFrom('threads')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
}

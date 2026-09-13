import { db } from '@db/db';
import type { Thread } from '@db/types';

type ListThreadsByUserProps = {
  userId: string;
};

/**
 * Threads owned by a user, newest first. `id` desc is a deterministic
 * tie-breaker for rows sharing the same `created_at`.
 */
export async function listThreadsByUser({ userId }: ListThreadsByUserProps): Promise<Thread[]> {
  return db
    .selectFrom('threads')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
}

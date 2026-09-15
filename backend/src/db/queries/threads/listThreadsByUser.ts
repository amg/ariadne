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
    .where('userId', '=', userId)
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .execute();
}

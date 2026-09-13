import { db } from '@db/db';
import type { Thread } from '@db/types';

type UpdateThreadTitleProps = {
  userId: string;
  threadId: string;
  title: string;
};

/**
 * Renames a thread owned by the user. Returns the updated row, or undefined
 * when the thread is unknown or belongs to someone else (no information
 * leakage either way).
 */
export async function updateThreadTitle({
  userId,
  threadId,
  title,
}: UpdateThreadTitleProps): Promise<Thread | undefined> {
  return db
    .updateTable('threads')
    .set({ title })
    .where('id', '=', threadId)
    .where('user_id', '=', userId)
    .returningAll()
    .executeTakeFirst();
}

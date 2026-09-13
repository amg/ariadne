import type { Database, Thread } from '@db/types';
import { insertThread } from '@queries/threads/insertThread';
import { listThreadsByUser } from '@queries/threads/listThreadsByUser';
import { updateThreadTitle } from '@queries/threads/updateThreadTitle';
import type { Kysely } from 'kysely';

export const DEFAULT_THREAD_TITLE = 'New Chat';
const MAX_TITLE_LENGTH = 255;

export class ThreadValidationError extends Error {}

/**
 * The single writer for thread titles. Used today by the manual rename UI;
 * a future auto-titling service (cheap model, see FUTURE-IMPROVEMENTS) should
 * reuse this instead of updating the table directly.
 */
export async function renameThread(
  db: Kysely<Database>,
  userId: string,
  threadId: string,
  title: string,
): Promise<Thread | null> {
  const normalized = title.trim();
  if (normalized.length === 0) {
    throw new ThreadValidationError('Thread title cannot be empty');
  }
  if (normalized.length > MAX_TITLE_LENGTH) {
    throw new ThreadValidationError(`Thread title exceeds ${MAX_TITLE_LENGTH} characters`);
  }

  const updated = await updateThreadTitle(db, userId, threadId, normalized);
  return updated ?? null;
}

export async function getThreads(db: Kysely<Database>, userId: string): Promise<Thread[]> {
  return listThreadsByUser(db, userId);
}

export async function createThread(
  db: Kysely<Database>,
  userId: string,
  title?: string,
): Promise<Thread> {
  const trimmed = title?.trim();
  return insertThread(db, {
    user_id: userId,
    title: trimmed ? trimmed : DEFAULT_THREAD_TITLE,
  });
}

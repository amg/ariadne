import type { Thread } from '@db/types';
import { insertThread } from '@queries/threads/insertThread';
import { listThreadsByUser } from '@queries/threads/listThreadsByUser';
import { updateThreadTitle } from '@queries/threads/updateThreadTitle';

export const DEFAULT_THREAD_TITLE = 'New Chat';
const MAX_TITLE_LENGTH = 255;

export class ThreadValidationError extends Error {}

/**
 * The single writer for thread titles. Used today by the manual rename UI;
 * a future auto-titling service (cheap model, see FUTURE-IMPROVEMENTS) should
 * reuse this instead of updating the table directly.
 */
export async function renameThread(
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

  const updated = await updateThreadTitle(userId, threadId, normalized);
  return updated ?? null;
}

export async function getThreads(userId: string): Promise<Thread[]> {
  return listThreadsByUser(userId);
}

export async function createThread(userId: string, title?: string): Promise<Thread> {
  const trimmed = title?.trim();
  return insertThread({
    user_id: userId,
    title: trimmed ? trimmed : DEFAULT_THREAD_TITLE,
  });
}

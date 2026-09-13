import type { Thread } from '@db/types';
import { deleteThread as deleteThreadQuery } from '@queries/threads/deleteThread';
import { insertThread } from '@queries/threads/insertThread';
import { listThreadsByUser } from '@queries/threads/listThreadsByUser';
import { updateThreadTitle } from '@queries/threads/updateThreadTitle';

export const DEFAULT_THREAD_TITLE = 'New Chat';
const MAX_TITLE_LENGTH = 255;

export class ThreadValidationError extends Error {}

type RenameThreadProps = {
  userId: string;
  threadId: string;
  title: string;
};

/**
 * The single writer for thread titles. Used today by the manual rename UI;
 * a future auto-titling service (cheap model, see FUTURE-IMPROVEMENTS) should
 * reuse this instead of updating the table directly.
 */
export async function renameThread({
  userId,
  threadId,
  title,
}: RenameThreadProps): Promise<Thread | null> {
  const normalized = title.trim();
  if (normalized.length === 0) {
    throw new ThreadValidationError('Thread title cannot be empty');
  }
  if (normalized.length > MAX_TITLE_LENGTH) {
    throw new ThreadValidationError(`Thread title exceeds ${MAX_TITLE_LENGTH} characters`);
  }

  const updated = await updateThreadTitle({ userId, threadId, title: normalized });
  return updated ?? null;
}

type DeleteThreadProps = {
  userId: string;
  threadId: string;
};

/**
 * Removes a thread (and its messages via FK cascade). Returns whether
 * anything was deleted; unknown or foreign threads simply yield false.
 */
export async function deleteThread({ userId, threadId }: DeleteThreadProps): Promise<boolean> {
  return deleteThreadQuery({ userId, threadId });
}

type GetThreadsProps = {
  userId: string;
};

export async function getThreads({ userId }: GetThreadsProps): Promise<Thread[]> {
  return listThreadsByUser({ userId });
}

type CreateThreadProps = {
  userId: string;
  title?: string;
};

export async function createThread({ userId, title }: CreateThreadProps): Promise<Thread> {
  const trimmed = title?.trim();
  return insertThread({ user_id: userId, title: trimmed ? trimmed : DEFAULT_THREAD_TITLE });
}

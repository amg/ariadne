import type { Thread } from '@db/types';
import { deleteThread as deleteThreadQuery } from '@queries/threads/deleteThread';
import { insertThread } from '@queries/threads/insertThread';
import { listThreadsByUser } from '@queries/threads/listThreadsByUser';
import { updateThreadTitle } from '@queries/threads/updateThreadTitle';
import { type MemoryFeature, seedThread } from '@services/memory';

const MAX_TITLE_LENGTH = 50;

export class ThreadValidationError extends Error {}

type RenameThreadProps = {
  userId: string;
  threadId: string;
  title: string;
};

/**
 * The single writer for thread titles. Used by the manual rename UI and by
 * the auto-titling service (`titlingService`); nothing else may update the
 * table directly.
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
  memory: MemoryFeature;
};

/**
 * Opens a fresh Thread, seeded with what the Memory knows about the user;
 * without Memory it opens unseeded.
 */
export async function createThread({ userId, memory }: CreateThreadProps): Promise<Thread> {
  const thread = await insertThread({ userId });
  if (memory.kind === 'on') await seedThread({ userId, threadId: thread.id });
  return thread;
}

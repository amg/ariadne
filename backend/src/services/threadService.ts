import type { Database, Thread } from '@db/types';
import { insertThread } from '@queries/threads/insertThread';
import { listThreadsByUser } from '@queries/threads/listThreadsByUser';
import { DEFAULT_USER_ID } from '@services/userService';
import type { Kysely } from 'kysely';

const DEFAULT_THREAD_TITLE = 'New Chat';

export async function getThreads(db: Kysely<Database>): Promise<Thread[]> {
  return listThreadsByUser(db, DEFAULT_USER_ID);
}

export async function createThread(db: Kysely<Database>, title?: string): Promise<Thread> {
  return insertThread(db, {
    user_id: DEFAULT_USER_ID,
    title: title || DEFAULT_THREAD_TITLE,
  });
}

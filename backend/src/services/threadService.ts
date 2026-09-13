import { db } from '@db/db';
import type { NewThread, Thread } from '../db/types';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000000';

export async function getThreads(): Promise<Thread[]> {
  return db
    .selectFrom('threads')
    .selectAll()
    .where('user_id', '=', DEFAULT_USER_ID)
    .orderBy('created_at', 'desc')
    .execute();
}

export async function createThread(title?: string): Promise<Thread> {
  return db
    .insertInto('threads')
    .values({
      user_id: DEFAULT_USER_ID,
      title: title || 'New Chat',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

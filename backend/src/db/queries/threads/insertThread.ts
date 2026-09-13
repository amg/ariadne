import { db } from '@db/db';
import type { NewThread, Thread } from '@db/types';

export async function insertThread(thread: NewThread): Promise<Thread> {
  return db.insertInto('threads').values(thread).returningAll().executeTakeFirstOrThrow();
}

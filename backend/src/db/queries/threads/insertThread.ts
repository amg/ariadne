import { db } from '@db/db';
import type { NewThread } from '@db/types';

export async function insertThread(thread: NewThread) {
  return db.insertInto('chat.threads').values(thread).returningAll().executeTakeFirstOrThrow();
}

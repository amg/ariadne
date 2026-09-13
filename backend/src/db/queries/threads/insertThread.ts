import type { Database, NewThread, Thread } from '@db/types';
import type { Kysely } from 'kysely';

export async function insertThread(db: Kysely<Database>, thread: NewThread): Promise<Thread> {
  return db.insertInto('threads').values(thread).returningAll().executeTakeFirstOrThrow();
}

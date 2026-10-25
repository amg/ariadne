import { db } from '@db/db';
import type { DbExecutor, NewMessage } from '@db/types';

export async function insertMessage(message: NewMessage, executor: DbExecutor = db) {
  return executor
    .insertInto('chat.messages')
    .values(message)
    .returningAll()
    .executeTakeFirstOrThrow();
}

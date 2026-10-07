import { db } from '@db/db';
import type { DbExecutor, Message, NewMessage } from '@db/types';

export async function insertMessage(
  message: NewMessage,
  executor: DbExecutor = db,
): Promise<Message> {
  return executor.insertInto('messages').values(message).returningAll().executeTakeFirstOrThrow();
}

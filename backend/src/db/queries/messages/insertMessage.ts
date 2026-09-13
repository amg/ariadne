import { db } from '@db/db';
import type { Message, NewMessage } from '@db/types';

export async function insertMessage(message: NewMessage): Promise<Message> {
  return db.insertInto('messages').values(message).returningAll().executeTakeFirstOrThrow();
}

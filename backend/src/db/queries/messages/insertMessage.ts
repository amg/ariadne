import type { Database, Message, NewMessage } from '@db/types';
import type { Kysely } from 'kysely';

export async function insertMessage(db: Kysely<Database>, message: NewMessage): Promise<Message> {
  return db.insertInto('messages').values(message).returningAll().executeTakeFirstOrThrow();
}

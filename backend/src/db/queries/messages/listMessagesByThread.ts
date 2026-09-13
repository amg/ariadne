import type { Database, Message } from '@db/types';
import type { Kysely } from 'kysely';

export async function listMessagesByThread(
  db: Kysely<Database>,
  threadId: string,
): Promise<Message[]> {
  return db
    .selectFrom('messages')
    .selectAll()
    .where('thread_id', '=', threadId)
    .orderBy('created_at', 'asc')
    .execute();
}

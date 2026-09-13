import { db } from '@db/db';
import type { Message } from '@db/types';

export async function listMessagesByThread(threadId: string): Promise<Message[]> {
  return db
    .selectFrom('messages')
    .selectAll()
    .where('thread_id', '=', threadId)
    .orderBy('created_at', 'asc')
    .execute();
}

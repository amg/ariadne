import { db } from '@db/db';
import type { Message } from '@db/types';

type ListMessagesByThreadProps = {
  threadId: string;
};

export async function listMessagesByThread({
  threadId,
}: ListMessagesByThreadProps): Promise<Message[]> {
  return db
    .selectFrom('messages')
    .selectAll()
    .where('thread_id', '=', threadId)
    .orderBy('created_at', 'asc')
    .execute();
}

import { db } from '@db/db';
import type { Message, NewMessage } from '../db/types';

export async function getMessages(threadId: string): Promise<Message[]> {
  return db
    .selectFrom('messages')
    .selectAll()
    .where('thread_id', '=', threadId)
    .orderBy('created_at', 'asc')
    .execute();
}

export async function createMessage(message: NewMessage): Promise<Message> {
  return db.insertInto('messages').values(message).returningAll().executeTakeFirstOrThrow();
}

export async function createMockResponse(threadId: string, userContent: string): Promise<Message> {
  const aiContent = `Echo: ${userContent}`;

  return db
    .insertInto('messages')
    .values({
      thread_id: threadId,
      role: 'assistant',
      content: aiContent,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

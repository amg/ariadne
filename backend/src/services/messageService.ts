import type { Database, Message } from '@db/types';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import type { Kysely } from 'kysely';

export async function getMessages(db: Kysely<Database>, threadId: string): Promise<Message[]> {
  return listMessagesByThread(db, threadId);
}

/**
 * Placeholder "AI" response generator. Pure content logic, no DB access.
 * Will be replaced by a real provider call later.
 */
export function createEchoResponse(userContent: string): string {
  return `Echo: ${userContent}`;
}

/**
 * Full message-exchange flow: persist the user's message, generate and
 * persist the assistant response, return both.
 */
export async function submitMessage(
  db: Kysely<Database>,
  threadId: string,
  content: string,
): Promise<{ userMessage: Message; assistantMessage: Message }> {
  const userMessage = await insertMessage(db, {
    thread_id: threadId,
    role: 'user',
    content,
  });

  const assistantMessage = await insertMessage(db, {
    thread_id: threadId,
    role: 'assistant',
    content: createEchoResponse(content),
  });

  return { userMessage, assistantMessage };
}

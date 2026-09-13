import type { Message } from '@db/types';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';

export async function getMessages(userId: string, threadId: string): Promise<Message[] | null> {
  const thread = await findThreadByIdAndUser(userId, threadId);
  if (!thread) return null;
  return listMessagesByThread(threadId);
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
 * persist the assistant response, return both. Returns null when the thread
 * is unknown or belongs to another user (the caller answers 404).
 */
export async function submitMessage(
  userId: string,
  threadId: string,
  content: string,
): Promise<{ userMessage: Message; assistantMessage: Message } | null> {
  const thread = await findThreadByIdAndUser(userId, threadId);
  if (!thread) return null;

  const userMessage = await insertMessage({
    thread_id: threadId,
    role: 'user',
    content,
  });

  const assistantMessage = await insertMessage({
    thread_id: threadId,
    role: 'assistant',
    content: createEchoResponse(content),
  });

  return { userMessage, assistantMessage };
}

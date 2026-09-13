import type { Message } from '@db/types';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';

type GetMessagesProps = {
  userId: string;
  threadId: string;
};

export async function getMessages({
  userId,
  threadId,
}: GetMessagesProps): Promise<Message[] | null> {
  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) return null;
  return listMessagesByThread({ threadId });
}

/**
 * Placeholder "AI" response generator. Pure content logic, no DB access.
 * Will be replaced by a real provider call later.
 */
export function createEchoResponse(userContent: string): string {
  return `Echo: ${userContent}`;
}

type SubmitMessageProps = {
  userId: string;
  threadId: string;
  content: string;
};

/**
 * Full message-exchange flow: persist the user's message, generate and
 * persist the assistant response, return both. Returns null when the thread
 * is unknown or belongs to another user (the caller answers 404).
 */
export async function submitMessage({
  userId,
  threadId,
  content,
}: SubmitMessageProps): Promise<{ userMessage: Message; assistantMessage: Message } | null> {
  const thread = await findThreadByIdAndUser({ userId, threadId });
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

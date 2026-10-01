import { db } from '@db/db';

type ListMessagesWithUsageByThreadProps = {
  threadId: string;
};

/** Message row joined with its usage row (usage fields NULL when absent). */
export interface MessageWithUsageRow {
  id: string;
  role: 'user' | 'assistant' | 'system';
  model: string | null;
  costUsd: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
}

/**
 * All messages of a thread with their chat-spend rows left-joined,
 * oldest first. Threads without messages yield an empty list.
 */
export async function listMessagesWithUsageByThread({
  threadId,
}: ListMessagesWithUsageByThreadProps): Promise<MessageWithUsageRow[]> {
  return (await db
    .selectFrom('messages')
    .leftJoin('messageUsage', 'messageUsage.messageId', 'messages.id')
    .select([
      'messages.id as id',
      'messages.role as role',
      'messageUsage.model as model',
      'messageUsage.costUsd as costUsd',
      'messageUsage.promptTokens as promptTokens',
      'messageUsage.completionTokens as completionTokens',
      'messageUsage.cachedInputTokens as cachedInputTokens',
      'messageUsage.reasoningTokens as reasoningTokens',
    ])
    .where('messages.threadId', '=', threadId)
    .orderBy('messages.createdAt')
    .execute()) as unknown as MessageWithUsageRow[];
}

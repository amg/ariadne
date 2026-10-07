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
  estimatedReasoningTokens: number | null;
}

/**
 * All messages of a thread with their chat-spend rows left-joined,
 * oldest first. Threads without messages yield an empty list.
 */
export async function listMessagesWithUsageByThread({
  threadId,
}: ListMessagesWithUsageByThreadProps): Promise<MessageWithUsageRow[]> {
  return (await db
    .selectFrom('chat.messages')
    .leftJoin('billing.messageUsage', 'billing.messageUsage.messageId', 'chat.messages.id')
    .select([
      'chat.messages.id as id',
      'chat.messages.role as role',
      'billing.messageUsage.model as model',
      'billing.messageUsage.costUsd as costUsd',
      'billing.messageUsage.promptTokens as promptTokens',
      'billing.messageUsage.completionTokens as completionTokens',
      'billing.messageUsage.cachedInputTokens as cachedInputTokens',
      'billing.messageUsage.reasoningTokens as reasoningTokens',
      'billing.messageUsage.estimatedReasoningTokens as estimatedReasoningTokens',
    ])
    .where('chat.messages.threadId', '=', threadId)
    .orderBy('chat.messages.createdAt')
    .execute()) as unknown as MessageWithUsageRow[];
}

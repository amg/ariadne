import { db } from '@db/db';
import type { Message } from '@db/types';

type ListMessagesByThreadProps = {
  threadId: string;
};

/**
 * A `messages` row flattened with its optional `message_usage` columns.
 * All `usage*` fields are null when the message has no usage row yet
 * (user messages, in-flight or interrupted assistant messages). The
 * CamelCasePlugin maps `usageModel` → `usage_model` etc. in SQL and maps
 * the result row back to camelCase.
 */
export type MessageWithUsageRow = Message & {
  usageModel: string | null;
  usageProviderId: string | null;
  usagePromptTokens: number | null;
  usageCompletionTokens: number | null;
  usageCachedInputTokens: number | null;
  usageCacheWriteTokens: number | null;
  usageReasoningTokens: number | null;
  usageEstimatedReasoningTokens: number | null;
  usageCostUsd: string | null;
  usageFinishReason: string | null;
  usageLatencyMs: number | null;
};

export async function listMessagesByThread({
  threadId,
}: ListMessagesByThreadProps): Promise<MessageWithUsageRow[]> {
  return db
    .selectFrom('messages')
    .leftJoin('messageUsage', 'messageUsage.messageId', 'messages.id')
    .selectAll('messages')
    .select([
      'messageUsage.model as usageModel',
      'messageUsage.providerId as usageProviderId',
      'messageUsage.promptTokens as usagePromptTokens',
      'messageUsage.completionTokens as usageCompletionTokens',
      'messageUsage.cachedInputTokens as usageCachedInputTokens',
      'messageUsage.cacheWriteTokens as usageCacheWriteTokens',
      'messageUsage.reasoningTokens as usageReasoningTokens',
      'messageUsage.estimatedReasoningTokens as usageEstimatedReasoningTokens',
      'messageUsage.costUsd as usageCostUsd',
      'messageUsage.finishReason as usageFinishReason',
      'messageUsage.latencyMs as usageLatencyMs',
    ])
    .where('messages.threadId', '=', threadId)
    .orderBy('messages.createdAt', 'asc')
    .execute();
}

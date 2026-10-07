import { db } from '@db/db';
import type { Message } from '@db/types';

type ListMessagesByThreadProps = {
  threadId: string;
};

/**
 * A `chat.messages` row flattened with its optional chat-spend columns. All
 * `usage*` fields are null when the message has no usage row yet (user
 * messages, in-flight assistant messages). The CamelCasePlugin maps
 * `usageModel` → `usage_model` etc. in SQL and maps the result row back
 * to camelCase.
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
  usageEstimated: boolean | null;
};

export async function listMessagesByThread({
  threadId,
}: ListMessagesByThreadProps): Promise<MessageWithUsageRow[]> {
  return db
    .selectFrom('chat.messages')
    .leftJoin('billing.messageUsage', 'billing.messageUsage.messageId', 'chat.messages.id')
    .selectAll('chat.messages')
    .select([
      'billing.messageUsage.model as usageModel',
      'billing.messageUsage.providerId as usageProviderId',
      'billing.messageUsage.promptTokens as usagePromptTokens',
      'billing.messageUsage.completionTokens as usageCompletionTokens',
      'billing.messageUsage.cachedInputTokens as usageCachedInputTokens',
      'billing.messageUsage.cacheWriteTokens as usageCacheWriteTokens',
      'billing.messageUsage.reasoningTokens as usageReasoningTokens',
      'billing.messageUsage.estimatedReasoningTokens as usageEstimatedReasoningTokens',
      'billing.messageUsage.costUsd as usageCostUsd',
      'billing.messageUsage.finishReason as usageFinishReason',
      'billing.messageUsage.latencyMs as usageLatencyMs',
      'billing.messageUsage.estimated as usageEstimated',
    ])
    .where('chat.messages.threadId', '=', threadId)
    .orderBy('chat.messages.createdAt', 'asc')
    .execute();
}

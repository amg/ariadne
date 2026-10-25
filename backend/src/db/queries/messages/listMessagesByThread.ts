import { db } from '@db/db';
import { tagQuery } from '@db/queryTag';
import type { DbExecutor } from '@db/types';

type ListMessagesByThreadProps = {
  threadId: string;
};

/**
 * A thread's messages, oldest first, each flattened with its optional chat-spend
 * columns. All `usage*` fields are null when the message has no usage row yet
 * (user messages, in-flight assistant messages).
 */
export async function listMessagesByThread(
  { threadId }: ListMessagesByThreadProps,
  executor: DbExecutor = db,
) {
  return executor
    .withPlugin(tagQuery('messages/listMessagesByThread'))
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

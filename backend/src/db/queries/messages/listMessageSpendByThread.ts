import { db } from '@db/db';

type ListMessageSpendByThreadProps = {
  threadId: string;
};

/**
 * The spend of every message in a thread, abandoned ones included,
 * oldest first. A message with no usage row has NULL spend figures.
 * Threads without messages yield an empty list.
 */
export async function listMessageSpendByThread({ threadId }: ListMessageSpendByThreadProps) {
  return db
    .selectFrom('chat.messages')
    .leftJoin('billing.messageUsage', 'billing.messageUsage.messageId', 'chat.messages.id')
    .select([
      'chat.messages.id as id',
      'chat.messages.role as role',
      'chat.messages.abandoned as abandoned',
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
    .execute();
}

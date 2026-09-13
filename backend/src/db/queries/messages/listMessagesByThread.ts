import { db } from '@db/db';
import type { Message } from '@db/types';

type ListMessagesByThreadProps = {
  threadId: string;
};

/**
 * A `messages` row flattened with its optional `message_usage` columns.
 * All `usage_*` fields are null when the message has no usage row yet
 * (user messages, in-flight or interrupted assistant messages).
 */
export type MessageWithUsageRow = Message & {
  usage_model: string | null;
  usage_provider_id: string | null;
  usage_prompt_tokens: number | null;
  usage_completion_tokens: number | null;
  usage_cached_input_tokens: number | null;
  usage_cache_write_tokens: number | null;
  usage_reasoning_tokens: number | null;
  usage_cost_usd: string | null;
  usage_finish_reason: string | null;
  usage_latency_ms: number | null;
};

export async function listMessagesByThread({
  threadId,
}: ListMessagesByThreadProps): Promise<MessageWithUsageRow[]> {
  return db
    .selectFrom('messages')
    .leftJoin('message_usage', 'message_usage.message_id', 'messages.id')
    .selectAll('messages')
    .select([
      'message_usage.model as usage_model',
      'message_usage.provider_id as usage_provider_id',
      'message_usage.prompt_tokens as usage_prompt_tokens',
      'message_usage.completion_tokens as usage_completion_tokens',
      'message_usage.cached_input_tokens as usage_cached_input_tokens',
      'message_usage.cache_write_tokens as usage_cache_write_tokens',
      'message_usage.reasoning_tokens as usage_reasoning_tokens',
      'message_usage.cost_usd as usage_cost_usd',
      'message_usage.finish_reason as usage_finish_reason',
      'message_usage.latency_ms as usage_latency_ms',
    ])
    .where('messages.thread_id', '=', threadId)
    .orderBy('messages.created_at', 'asc')
    .execute();
}

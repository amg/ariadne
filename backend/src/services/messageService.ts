import type { Message, MessageFinishReason, MessageUsage } from '@db/types';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import type { MessageWithUsageRow } from '@queries/messages/listMessagesByThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';

/** Usage as served on the GET payload (identity columns implied by the row). */
export type UsagePayload = Omit<MessageUsage, 'message_id' | 'created_at'>;

export type MessageWithUsage = Message & {
  /** Inference telemetry for assistant messages; null until available. */
  usage: UsagePayload | null;
};

/** Flattens the join aliases from `listMessagesByThread` into a nested row. */
export function messageRowToMessageWithUsage(row: MessageWithUsageRow): MessageWithUsage {
  const {
    usage_model: model,
    usage_provider_id: provider_id,
    usage_prompt_tokens: prompt_tokens,
    usage_completion_tokens: completion_tokens,
    usage_cached_input_tokens: cached_input_tokens,
    usage_cache_write_tokens: cache_write_tokens,
    usage_reasoning_tokens: reasoning_tokens,
    usage_cost_usd: cost_usd,
    usage_finish_reason: finish_reason,
    usage_latency_ms: latency_ms,
    ...message
  } = row;

  if (
    model === null ||
    provider_id === null ||
    prompt_tokens === null ||
    completion_tokens === null ||
    cost_usd === null ||
    finish_reason === null
  ) {
    return { ...message, usage: null };
  }
  return {
    ...message,
    usage: {
      model,
      provider_id,
      prompt_tokens,
      completion_tokens,
      // NULL is meaningful: the provider didn't report these fields.
      cached_input_tokens,
      cache_write_tokens,
      reasoning_tokens,
      cost_usd,
      finish_reason: finish_reason as MessageFinishReason,
      latency_ms,
    },
  };
}

type GetMessagesProps = {
  userId: string;
  threadId: string;
};

export async function getMessages({
  userId,
  threadId,
}: GetMessagesProps): Promise<MessageWithUsage[] | null> {
  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) return null;
  const rows = await listMessagesByThread({ threadId });
  return rows.map(messageRowToMessageWithUsage);
}

import type { Message, MessageFinishReason, MessageUsage } from '@db/types';
import { deleteMessage } from '@queries/messages/deleteMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import type { MessageWithUsageRow } from '@queries/messages/listMessagesByThread';
import { updateMessageContent } from '@queries/messages/updateMessageContent';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { type Result, err, ok } from '../types/result';

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

type UpdateMessageProps = {
  userId: string;
  threadId: string;
  messageId: string;
  content: string;
};

/** Hard cap on a single message edit — far beyond any realistic prompt. */
const MAX_MESSAGE_CONTENT_LENGTH = 10_000;

/**
 * The single writer for persisted message content — prompts only. The
 * thread's last user message is editable; saving is a rewrite-and-resend
 * affordance, so any assistant replies following the edited prompt are
 * deleted (usage rows cascade). Assistant replies themselves are never
 * edited — retry (chat regenerate) is their recovery path. "not_last"
 * (409) and "thread_not_found" (404) keep foreign/unknown ids
 * indistinguishable from permission failures.
 */
export async function updateMessage({
  userId,
  threadId,
  messageId,
  content,
}: UpdateMessageProps): Promise<Result<MessageWithUsage>> {
  const normalized = content.trim();
  if (normalized.length === 0) {
    return err('invalid_content', 'Message content cannot be empty.');
  }
  if (normalized.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return err(
      'invalid_content',
      `Message content exceeds ${MAX_MESSAGE_CONTENT_LENGTH} characters.`,
    );
  }

  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) return err('thread_not_found');

  const rows = await listMessagesByThread({ threadId });
  if (!rows.some((row) => row.id === messageId)) return err('thread_not_found');

  let lastUserIndex = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  const lastUser = lastUserIndex >= 0 ? rows[lastUserIndex] : undefined;
  if (!lastUser || lastUser.id !== messageId) {
    return err('not_last', 'Only the last user message in a thread can be edited.');
  }

  // Replies after the edited prompt were generated from the old text; drop
  // them (the client immediately retries the exchange from the new prompt).
  for (const row of rows.slice(lastUserIndex + 1)) {
    await deleteMessage({ messageId: row.id });
  }

  await updateMessageContent({ messageId, content: normalized });
  return ok(messageRowToMessageWithUsage({ ...lastUser, content: normalized }));
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

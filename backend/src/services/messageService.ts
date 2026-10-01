import { env } from '@config/env';
import type { Message, MessageFinishReason, MessageUsage } from '@db/types';
import { deleteMessageEmbeddingsByMessageIds } from '@queries/messageEmbeddings/deleteMessageEmbeddingsByMessageIds';
import { deleteMessage } from '@queries/messages/deleteMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import type { MessageWithUsageRow } from '@queries/messages/listMessagesByThread';
import { updateMessageContent } from '@queries/messages/updateMessageContent';
import { deleteSegmentDriftLogsByMessageIds } from '@queries/segmentDriftLogs/deleteSegmentDriftLogsByMessageIds';
import { listSegmentDriftLogsByThread } from '@queries/segmentDriftLogs/listSegmentDriftLogsByThread';
import { deleteThreadSegmentsByStartMessageIds } from '@queries/threadSegments/deleteThreadSegmentsByStartMessageIds';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { type Result, err, ok } from '../types/result';
import { EMBEDDING_MODEL_ID, SYSTEM_PROMPT } from './aiService/config';

/** Usage as served on the GET payload (identity columns implied by the row). */
export type UsagePayload = Omit<MessageUsage, 'messageId' | 'createdAt'>;

/**
 * The live gate's two-channel verdict on a user arrival — the Conversation
 * tab's purple bubble. null on non-user rows, on threads with no persisted
 * verdict row yet, and while the feature flag is off (stored signals
 * survive the off period; the surface just stops wearing them).
 */
export type DriftVerdictPayload = {
  verdict: 'muted' | 'pass' | 'fire';
  fireChannel: 'immediate' | 'slow' | null;
} | null;

export type MessageWithUsage = Message & {
  /** Inference telemetry for assistant messages; null until available. */
  usage: UsagePayload | null;
  driftVerdict: DriftVerdictPayload;
};

/** Flattens the join aliases from `listMessagesByThread` into a nested row. */
export function messageRowToMessageWithUsage(
  row: MessageWithUsageRow,
  driftVerdict: DriftVerdictPayload = null,
): MessageWithUsage {
  const {
    usageModel: model,
    usageProviderId: providerId,
    usagePromptTokens: promptTokens,
    usageCompletionTokens: completionTokens,
    usageCachedInputTokens: cachedInputTokens,
    usageCacheWriteTokens: cacheWriteTokens,
    usageReasoningTokens: reasoningTokens,
    usageEstimatedReasoningTokens: estimatedReasoningTokens,
    usageCostUsd: costUsd,
    usageFinishReason: finishReason,
    usageLatencyMs: latencyMs,
    usageEstimated: estimated,
    ...message
  } = row;

  if (model === null || costUsd === null || finishReason === null) {
    return { ...message, usage: null, driftVerdict };
  }
  return {
    ...message,
    usage: {
      model,
      providerId,
      // NOT NULL whenever the usage row exists; the join types them nullable.
      promptTokens: promptTokens ?? 0,
      completionTokens: completionTokens ?? 0,
      // NULL is meaningful: the provider didn't report these fields.
      cachedInputTokens,
      cacheWriteTokens,
      reasoningTokens,
      estimatedReasoningTokens,
      costUsd,
      finishReason: finishReason as MessageFinishReason,
      latencyMs,
      estimated: estimated === true,
    },
    driftVerdict,
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

  // Live chain invalidation: the arrival signal for the edited row and
  // everything after it came from the old reading. Arrival embeddings,
  // drift logs and segment starts drop here; the chain re-fills itself the
  // next time an arrival lands or the analysis surface reads it.
  const invalidatedRows = rows.slice(lastUserIndex);
  const invalidatedUserIds = invalidatedRows
    .filter((row) => row.role === 'user')
    .map((row) => row.id);
  await deleteMessageEmbeddingsByMessageIds({
    messageIds: invalidatedRows.map((row) => row.id),
  });
  await deleteSegmentDriftLogsByMessageIds({ messageIds: invalidatedUserIds });
  await deleteThreadSegmentsByStartMessageIds({ startMessageIds: invalidatedUserIds });

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

  // Per-arrival verdict straight from the persisted live chain (no
  // computation here). The flag suppresses the surface, never the store.
  const driftLogs =
    env.THREAD_ANALYSIS_MODE === 'off'
      ? []
      : await listSegmentDriftLogsByThread({ threadId, modelId: EMBEDDING_MODEL_ID });
  const verdictByMessageId = new Map(
    driftLogs.map((log): [string, NonNullable<DriftVerdictPayload>] => [
      log.messageId,
      {
        verdict: log.verdict as NonNullable<DriftVerdictPayload>['verdict'],
        fireChannel: log.fireChannel as NonNullable<DriftVerdictPayload>['fireChannel'],
      },
    ]),
  );

  const messages = rows.map((row) =>
    messageRowToMessageWithUsage(
      row,
      row.role === 'user' ? (verdictByMessageId.get(row.id) ?? null) : null,
    ),
  );

  const seededSystemMessage: MessageWithUsage = {
    id: `system-${threadId}`,
    threadId,
    role: 'system',
    content: SYSTEM_PROMPT,
    exchangeStatus: 'completed',
    createdAt: thread.createdAt,
    usage: null,
    driftVerdict: null,
  };

  if (messages.length === 0 || messages[0]?.role !== 'system') {
    messages.unshift(seededSystemMessage);
  }

  return messages;
}

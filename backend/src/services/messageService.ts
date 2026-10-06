import { env } from '@config/env';
import type { Message, MessageFinishReason, MessageUsage } from '@db/types';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import type { MessageWithUsageRow } from '@queries/messages/listMessagesByThread';
import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import { listSegmentDriftLogsByThread } from '@queries/segmentDriftLogs/listSegmentDriftLogsByThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { inTransaction } from '@queries/transaction/inTransaction';
import { type Result, err, ok } from '../types/result';
import type { ArrivalJudging } from './aiService/arrivalGate';
import { EMBEDDING_MODEL_ID, SYSTEM_PROMPT } from './aiService/config';
import { validateMessageContent } from './validation';

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
  judging: Pick<ArrivalJudging, 'enqueueDriftGateJudgeArrival'>;
};

/**
 * The edit fork — prompts only. The thread's last live user message is
 * editable; an abandoned arrival after it (one handed over to another
 * Thread, say) never counts. An edit ABANDONS its arrival rather than
 * rewriting it:
 * the old row keeps its text and its arrival analysis (still correct for
 * the untouched reading), so its spend keeps tracking the pre-edit costs;
 * every reply grown from the old text is abandoned with it. The edited
 * text lands as a NEW user row after them — a fresh arrival, its Drift
 * gate judgment queued with it; the retry then exchanges or pauses it. Abandoned rows are never rewritten
 * and never deleted; inference memory, listing, drafting and the analysis
 * surface simply skip them. Assistant replies themselves are never edited
 * — retry (chat regenerate) is their recovery path. "not_last" (409) and
 * "thread_not_found" (404) keep foreign/unknown ids indistinguishable
 * from permission failures.
 */
export async function editMessage({
  userId,
  threadId,
  messageId,
  content,
  judging,
}: UpdateMessageProps): Promise<Result<MessageWithUsage>> {
  const contentResult = validateMessageContent(content);
  if (contentResult.type === 'error') return contentResult;
  const normalized = contentResult.data;

  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) return err('thread_not_found');

  const rows = await listMessagesByThread({ threadId });
  if (!rows.some((row) => row.id === messageId)) return err('thread_not_found');

  let lastUserIndex = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.role === 'user' && !rows[i]?.abandoned) {
      lastUserIndex = i;
      break;
    }
  }
  const lastUser = lastUserIndex >= 0 ? rows[lastUserIndex] : undefined;
  if (!lastUser || lastUser.id !== messageId) {
    return err('not_last', 'Only the last user message in a thread can be edited.');
  }

  // The old arrival and every reply grown from its text are abandoned in
  // place: rows stay — text, arrival analysis and usage keep tracking what
  // the thread burned — while retry, inference memory and listing skip
  // them. The fork lands after them, in the same step as its judgment.
  const forked = await inTransaction(async (trx) => {
    await setMessagesAbandoned(
      {
        messageIds: [
          lastUser.id,
          ...rows
            .slice(lastUserIndex + 1)
            .filter((row) => !row.abandoned)
            .map((row) => row.id),
        ],
        abandoned: true,
      },
      trx,
    );
    const fork = await insertMessage({ threadId, role: 'user', content: normalized }, trx);
    await judging.enqueueDriftGateJudgeArrival({ userId, threadId, messageId: fork.id }, trx);
    return fork;
  });
  return ok(
    messageRowToMessageWithUsage({
      ...forked,
      usageModel: null,
      usageProviderId: null,
      usagePromptTokens: null,
      usageCompletionTokens: null,
      usageCachedInputTokens: null,
      usageCacheWriteTokens: null,
      usageReasoningTokens: null,
      usageEstimatedReasoningTokens: null,
      usageCostUsd: null,
      usageFinishReason: null,
      usageLatencyMs: null,
      usageEstimated: null,
    }),
  );
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
    abandoned: false,
    createdAt: thread.createdAt,
    usage: null,
    driftVerdict: null,
  };

  if (messages.length === 0 || messages[0]?.role !== 'system') {
    messages.unshift(seededSystemMessage);
  }

  return messages;
}

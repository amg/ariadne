import type { MessageDriftVerdict } from '@ari/lib/api/schemas/common/driftGate';
import type { ThreadAnalysisMode } from '@ari/lib/api/schemas/threads/analysis';
import type { Message, MessageUsage } from '@db/types';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { lockLiveMessage } from '@queries/messages/lockLiveMessage';
import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import { listSegmentDriftLogsByThread } from '@queries/segmentDriftLogs/listSegmentDriftLogsByThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { inTransaction } from '@queries/transaction/inTransaction';
import { findDriftGateJudgeArrivalJobOrNull } from '@queue/tasks/driftGateJudgeArrivalTask';
import type { ArrivalJudging } from '../types/aiService';
import { type Result, err, ok } from '../types/result';
import { judgmentFailed } from './aiService/arrivalGate';
import { EMBEDDING_MODEL_ID, SYSTEM_PROMPT } from './aiService/config';
import { newestLiveUserIndex } from './aiService/newestLiveUser';
import { validateMessageContent } from './validation';

/** A message as `listMessagesByThread` returns it, with its usage columns flattened in. */
type ThreadMessage = Awaited<ReturnType<typeof listMessagesByThread>>[number];

/** Usage as served on the GET payload (identity columns implied by the row). */
type UsagePayload = Omit<MessageUsage, 'messageId' | 'createdAt'>;

type MessageWithUsage = Message & {
  /** Inference telemetry for assistant messages; null until available. */
  usage: UsagePayload | null;
  /**
   * The live gate's two-channel verdict on a user arrival. null on non-user
   * rows, on threads with no persisted verdict row yet, and while the
   * feature flag is off (stored signals survive the off period).
   */
  driftVerdict: MessageDriftVerdict | null;
  /**
   * True on the Thread's Unanswered arrival when the Drift gate could not
   * judge it and gave up for good; false everywhere else.
   */
  gateFailed: boolean;
};

/** Flattens the join aliases from `listMessagesByThread` into a nested row. */
function messageRowToMessageWithUsage(
  row: ThreadMessage,
  driftVerdict: MessageDriftVerdict | null = null,
  gateFailed = false,
) {
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
    return { ...message, usage: null, driftVerdict, gateFailed };
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
      finishReason,
      latencyMs,
      estimated: estimated === true,
    },
    driftVerdict,
    gateFailed,
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
 * The edit fork, for prompts only. The Thread's last live user message is
 * editable; an abandoned arrival after it (one handed over to another
 * Thread, say) never counts. An edit abandons its arrival rather than
 * rewriting it. The old row keeps its text and its arrival analysis, so
 * its spend keeps tracking the pre-edit costs, and every reply grown from
 * the old text is abandoned with it. The edited text lands as a new user
 * row after them: a fresh arrival, with its Drift gate judgment queued
 * alongside. Assistant replies are never edited; a retry replaces them.
 * An unknown or foreign Thread, or a message not in it, fails with
 * `thread_not_found`; a message that is not the last live one fails with
 * `not_last`.
 */
export async function editMessage({
  userId,
  threadId,
  messageId,
  content,
  judging,
}: UpdateMessageProps) {
  const contentResult = validateMessageContent(content);
  if (contentResult.type === 'error') return contentResult;
  const normalized = contentResult.data;

  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) return err('thread_not_found');

  const forked = await inTransaction(async (trx): Promise<Result<Message>> => {
    // Locked before the read, so the read sees what the one ahead left: a
    // reply that started on this arrival is abandoned with it, and a second
    // edit of it finds it already gone.
    const live = await lockLiveMessage({ threadId, messageId }, trx);
    const rows = await listMessagesByThread({ threadId }, trx);
    if (!rows.some((row) => row.id === messageId)) return err('thread_not_found');
    const lastUserIndex = newestLiveUserIndex(rows);
    if (!live || rows[lastUserIndex]?.id !== messageId) {
      return err('not_last', 'Only the last user message in a thread can be edited.');
    }

    // The old arrival and every reply grown from its text are abandoned in
    // place: rows stay, and text, arrival analysis and usage keep tracking
    // what the thread burned, while retry, inference memory and listing
    // skip them. The fork lands after them, in the same step as its judgment.
    await setMessagesAbandoned(
      {
        messageIds: [
          messageId,
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
    return ok(fork);
  });
  if (forked.type === 'error') return forked;
  return ok(
    messageRowToMessageWithUsage({
      ...forked.data,
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

/**
 * The Thread's Unanswered arrival whose judgment gave up for good, or null.
 * Only the newest live row can be one, and a stored verdict means it was
 * judged after all.
 */
async function gateFailedArrivalIdOrNull(
  rows: ThreadMessage[],
  verdictByMessageId: ReadonlyMap<string, unknown>,
): Promise<string | null> {
  const newestLive = rows.filter((row) => !row.abandoned).at(-1);
  if (newestLive?.role !== 'user' || verdictByMessageId.has(newestLive.id)) return null;
  const job = await findDriftGateJudgeArrivalJobOrNull(newestLive.id);
  return judgmentFailed(job) ? newestLive.id : null;
}

type GetMessagesProps = {
  userId: string;
  threadId: string;
  /** With the gate off, no verdict is shown and none can have failed. */
  threadAnalysisMode: ThreadAnalysisMode;
};

export async function getMessages({ userId, threadId, threadAnalysisMode }: GetMessagesProps) {
  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) return null;
  const rows = await listMessagesByThread({ threadId });

  // Per-arrival verdict straight from the persisted live chain (no
  // computation here). The flag suppresses the surface, never the store.
  const driftLogs =
    threadAnalysisMode === 'off'
      ? []
      : await listSegmentDriftLogsByThread({ threadId, modelId: EMBEDDING_MODEL_ID });
  const verdictByMessageId = new Map(
    driftLogs.map((log): [string, MessageDriftVerdict] => [
      log.messageId,
      { verdict: log.verdict, fireChannel: log.fireChannel },
    ]),
  );

  // With the gate switched off nothing is judged, so nothing can fail.
  const gateFailedId =
    threadAnalysisMode === 'off' ? null : await gateFailedArrivalIdOrNull(rows, verdictByMessageId);

  const messages = rows.map((row) =>
    messageRowToMessageWithUsage(
      row,
      row.role === 'user' ? (verdictByMessageId.get(row.id) ?? null) : null,
      row.id === gateFailedId,
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
    gateFailed: false,
  };

  if (messages.length === 0 || messages[0]?.role !== 'system') {
    messages.unshift(seededSystemMessage);
  }

  return messages;
}

import type { Message } from '@db/types';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { listUncapturedClosedSegments } from '@queries/threadSegments/listUncapturedClosedSegments';
import { markSegmentFactsCaptured } from '@queries/threadSegments/markSegmentFactsCaptured';
import { reopenSegmentsOfAbandonedClosers } from '@queries/threadSegments/reopenSegmentsOfAbandonedClosers';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { getUserSettings } from '@services/settingsService';
import { type CaptureTurn, captureFacts } from './captureFacts';

/**
 * The live Turns of a closed segment: from its first user Message up to,
 * not including, the Boundary arrival that closed it. Abandoned rows and
 * empty replies stay out.
 */
export function segmentTurns(
  rows: Message[],
  startMessageId: string,
  closingMessageId: string,
): CaptureTurn[] {
  const start = rows.findIndex((row) => row.id === startMessageId);
  const end = rows.findIndex((row) => row.id === closingMessageId);
  if (start < 0 || end <= start) return [];

  const live = rows.slice(start, end).filter((row) => !row.abandoned);
  const turns: CaptureTurn[] = [];
  for (let i = 0; i < live.length; i += 1) {
    const row = live[i];
    if (!row || row.role !== 'user') continue;
    const next = live[i + 1];
    const reply = next && next.role === 'assistant' && next.content !== '' ? next : null;
    turns.push({ userMessage: row, assistantReply: reply });
  }
  return turns;
}

async function captureOwedSegments(userId: string, threadId: string): Promise<void> {
  // An edit or a handover can abandon the arrival that closed a captured
  // segment, which reopens it: capture is owed again once it next closes.
  await reopenSegmentsOfAbandonedClosers({ threadId, modelId: EMBEDDING_MODEL_ID });
  const owed = await listUncapturedClosedSegments({ threadId, modelId: EMBEDDING_MODEL_ID });
  if (owed.length === 0) return;

  const settings = await getUserSettings({ userId });
  if (!settings.memoryEnabled) {
    // Memory off means nothing is gathered — not deferred until it turns on.
    for (const segment of owed) await markSegmentFactsCaptured({ segmentId: segment.segmentId });
    return;
  }

  const rows = await listMessagesByThread({ threadId });
  for (const segment of owed) {
    const captured = await captureFacts({
      userId,
      turns: segmentTurns(rows, segment.startMessageId, segment.closingMessageId),
      blockedCategories: settings.memoryBlockedCategories,
      spendMessageId: segment.closingMessageId,
    });
    if (captured.type === 'error') {
      // Left owed: the next pass over this thread retries it.
      console.error(
        `[captureClosedSegments] segment ${segment.segmentId} capture failed:`,
        captured.code,
        captured.message,
      );
      return;
    }
    await markSegmentFactsCaptured({ segmentId: segment.segmentId });
  }
}

const runsByThread = new Map<string, Promise<void>>();

/**
 * Resolves once every capture running or queued right now has finished,
 * so a shutdown (or a test resetting the database) does not cut one off.
 */
export async function capturesSettled(): Promise<void> {
  await Promise.all(runsByThread.values());
}

/**
 * Captures Facts from every segment of the thread a Boundary turn has
 * closed and whose capture is still owed. Never rejects: a failed segment
 * stays owed and the next call retries it. Calls on one thread run one
 * after another, so a caller awaiting this also waits out a capture that
 * is already running.
 */
export function captureClosedSegments({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}): Promise<void> {
  const previous = runsByThread.get(threadId) ?? Promise.resolve();
  const run = previous
    .then(() => captureOwedSegments(userId, threadId))
    .catch((error: unknown) => {
      console.error('[captureClosedSegments] capture pass failed:', error);
    });
  runsByThread.set(threadId, run);
  void run.finally(() => {
    if (runsByThread.get(threadId) === run) runsByThread.delete(threadId);
  });
  return run;
}

import type { FactCategory, Message } from '@db/types';
import { upsertCaptureProgress } from '@queries/memoryCaptureProgress/upsertCaptureProgress';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import type { SegmentNeedingCapture } from '@queries/threadSegments/listSegmentsNeedingCapture';
import { listSegmentsNeedingCapture } from '@queries/threadSegments/listSegmentsNeedingCapture';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { getUserSettings } from '@services/settingsService';
import { type CaptureTurn, captureFacts } from './captureFacts';

/**
 * The live Turns of a segment up to the row that settles it: from its first
 * user Message up to, not including, the settle row. Abandoned rows and
 * empty replies stay out.
 */
export function segmentTurns(
  rows: Message[],
  startMessageId: string,
  settleMessageId: string,
): CaptureTurn[] {
  const start = rows.findIndex((row) => row.id === startMessageId);
  const end = rows.findIndex((row) => row.id === settleMessageId);
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

/** One in-flight capture per thread; later passes within it queue up. */
const pool: { threadId: string; done: Promise<void> }[] = [];

/**
 * Resolves once the captures in flight for a Thread settle. With no Thread
 * given, settles every capture anywhere — what the test harness waits on.
 */
export function capturesSettled(threadId?: string): Promise<void> {
  const pending = pool.filter((entry) => threadId === undefined || entry.threadId === threadId);
  return Promise.allSettled(pending.map((entry) => entry.done)).then(() => undefined);
}

type SegmentToSettle = SegmentNeedingCapture & {
  userId: string;
  blockedCategories: readonly FactCategory[];
  turns: CaptureTurn[];
};

async function settleSegment(segment: SegmentToSettle): Promise<void> {
  const captured = await captureFacts({
    userId: segment.userId,
    turns: segment.turns,
    blockedCategories: segment.blockedCategories,
    spendMessageId: segment.anchorMessageId,
    capturedThroughAt: segment.capturedThroughAt,
  });
  if (captured.type === 'error') {
    // The pointer stays put, so the next pass retries just the Turns after it.
    console.error(
      `[captureClosedSegments] segment ${segment.segmentId} capture failed: ${captured.code}${
        captured.message ? `: ${captured.message}` : ''
      }`,
    );
    return;
  }
  await upsertCaptureProgress({ segmentId: segment.segmentId, throughAt: segment.anchorAt });
  if (captured.data.added > 0) {
    const extra =
      captured.data.skippedAsDuplicate > 0
        ? ` (+${captured.data.skippedAsDuplicate} duplicates skipped)`
        : '';
    console.log(
      `[captureClosedSegments] segment ${segment.segmentId}: ${captured.data.added} Fact(s)${extra}`,
    );
  }
}

async function captureOwedSegments(userId: string, threadId: string): Promise<void> {
  const owed = await listSegmentsNeedingCapture({ threadId, modelId: EMBEDDING_MODEL_ID });
  if (owed.length === 0) return;

  const settings = await getUserSettings({ userId });
  if (!settings.memoryEnabled) {
    // Memory off means nothing is gathered — not deferred until it turns on:
    // the pointer jumps to each segment's settle row.
    for (const segment of owed) {
      await upsertCaptureProgress({
        segmentId: segment.segmentId,
        throughAt: segment.anchorAt,
      });
    }
    return;
  }

  const rows = await listMessagesByThread({ threadId });
  for (const segment of owed) {
    await settleSegment({
      userId,
      blockedCategories: settings.memoryBlockedCategories,
      ...segment,
      turns: segmentTurns(rows, segment.startMessageId, segment.anchorMessageId),
    });
  }
}

/**
 * Runs one capture pass over a thread's live chain. Each pass is a separate
 * promise; overlapping passes on the same thread read the same state and
 * guard their pointer writes, so they do no more than re-check each other.
 */
export function captureClosedSegments({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}): Promise<void> {
  const entry = { threadId, done: captureOwedSegments(userId, threadId) };
  pool.push(entry);
  entry.done.finally(() => {
    const index = pool.indexOf(entry);
    if (index >= 0) pool.splice(index, 1);
  });
  return entry.done;
}

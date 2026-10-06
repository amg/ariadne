import type { Message } from '@db/types';
import { capturePointersOf } from '@queries/memoryCaptureProgress/capturePointersOf';
import { upsertCaptureProgress } from '@queries/memoryCaptureProgress/upsertCaptureProgress';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { listSegmentsNeedingCapture } from '@queries/threadSegments/listSegmentsNeedingCapture';
import { listThreadSegmentsByThread } from '@queries/threadSegments/listThreadSegmentsByThread';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { getUserSettings } from '@services/settingsService';
import { type CaptureTurn, captureFacts } from './captureFacts';

/**
 * The live Turns of a segment up to the row that settles it: from its first
 * user Message up to, not including, the settle row — or through the
 * thread's end when no row settles it yet (null). Abandoned rows and empty
 * replies stay out.
 */
export function segmentTurns(
  rows: Message[],
  startMessageId: string,
  settleMessageId: string | null,
): CaptureTurn[] {
  const start = rows.findIndex((row) => row.id === startMessageId);
  const end =
    settleMessageId === null ? rows.length : rows.findIndex((row) => row.id === settleMessageId);
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

/**
 * The newest segment's Turns through the thread's end, short of a last
 * Turn still without its reply (one streaming, or a Paused arrival): that
 * exchange is not over, so reading it would move the pointer past it.
 */
function unsettledTurns(rows: Message[], startMessageId: string): CaptureTurn[] {
  const turns = segmentTurns(rows, startMessageId, null);
  return turns.at(-1)?.assistantReply === null ? turns.slice(0, -1) : turns;
}

/** What one capture pass did, for a caller that reports it to the user. */
export interface CapturePassReport {
  /** False when memory is off: nothing was read. */
  memoryEnabled: boolean;
  /** Segments that held unread Turns when the pass reached them. */
  owed: number;
  /** Segments whose capture failed; their pointers stay put for a retry. */
  failed: number;
  added: number;
  /** Known Facts restated or corrected, now superseded by the newer reading. */
  replaced: number;
}

function emptyReport(memoryEnabled: boolean): CapturePassReport {
  return { memoryEnabled, owed: 0, failed: 0, added: 0, replaced: 0 };
}

/** One in-flight capture per thread; later passes within it queue up. */
const pool: { threadId: string; done: Promise<CapturePassReport> }[] = [];

function pooled(threadId: string, work: Promise<CapturePassReport>): Promise<CapturePassReport> {
  const entry = { threadId, done: work };
  pool.push(entry);
  entry.done.finally(() => {
    const index = pool.indexOf(entry);
    if (index >= 0) pool.splice(index, 1);
  });
  return entry.done;
}

/**
 * Resolves once the captures in flight for a Thread settle. With no Thread
 * given, settles every capture anywhere — what the test harness waits on.
 */
export function capturesSettled(threadId?: string): Promise<void> {
  const pending = pool.filter((entry) => threadId === undefined || entry.threadId === threadId);
  return Promise.allSettled(pending.map((entry) => entry.done)).then(() => undefined);
}

/** One segment's read: its Turns, and where its pointer lands after. */
type SegmentRead = {
  segmentId: string;
  turns: CaptureTurn[];
  capturedThroughAt: Date | null;
  /** The message the read's spend is recorded against. */
  spendMessageId: string;
  throughAt: Date;
};

type Settings = Awaited<ReturnType<typeof getUserSettings>>;

/**
 * Reads one segment past its pointer and adds the outcome to the report.
 * False when the read failed.
 */
async function readSegment(
  userId: string,
  settings: Settings,
  read: SegmentRead,
  report: CapturePassReport,
): Promise<boolean> {
  report.owed += 1;
  const captured = await captureFacts({
    userId,
    turns: read.turns,
    blockedCategories: settings.memoryBlockedCategories,
    spendMessageId: read.spendMessageId,
    capturedThroughAt: read.capturedThroughAt,
  });
  if (captured.type === 'error') {
    // The pointer stays put, so the next pass retries just the Turns after it.
    console.error(
      `[memory capture] segment ${read.segmentId} capture failed: ${captured.code}${
        captured.message ? `: ${captured.message}` : ''
      }`,
    );
    report.failed += 1;
    return false;
  }
  await upsertCaptureProgress({ segmentId: read.segmentId, throughAt: read.throughAt });
  report.added += captured.data.added;
  report.replaced += captured.data.replaced;
  if (captured.data.added + captured.data.replaced > 0) {
    console.log(
      `[memory capture] segment ${read.segmentId}: ${captured.data.added} Fact(s) added, ${captured.data.replaced} replaced`,
    );
  }
  return true;
}

async function captureOwedSegments(
  userId: string,
  threadId: string,
  settings: Settings,
): Promise<CapturePassReport> {
  const report = emptyReport(settings.memoryEnabled);
  const owed = await listSegmentsNeedingCapture({ threadId, modelId: EMBEDDING_MODEL_ID });
  if (owed.length === 0) return report;

  if (!settings.memoryEnabled) {
    // Memory off means nothing is gathered — not deferred until it turns on:
    // the pointer jumps to each segment's settle row.
    for (const segment of owed) {
      await upsertCaptureProgress({ segmentId: segment.segmentId, throughAt: segment.anchorAt });
    }
    return report;
  }

  // Oldest first, stopping at the first failure: a later segment is read
  // with what the earlier ones taught the Memory.
  const rows = await listMessagesByThread({ threadId });
  for (const segment of owed) {
    const read = await readSegment(
      userId,
      settings,
      {
        segmentId: segment.segmentId,
        turns: segmentTurns(rows, segment.startMessageId, segment.anchorMessageId),
        capturedThroughAt: segment.capturedThroughAt,
        spendMessageId: segment.anchorMessageId,
        throughAt: segment.anchorAt,
      },
      report,
    );
    if (!read) break;
  }
  return report;
}

/**
 * Reads the newest segment's answered Turns past its pointer, without
 * waiting for the segment to settle. The pointer then sits on the last
 * Turn read, so when the segment does settle its pass reads only what
 * came after, the rest riding along as context.
 */
async function captureNewestSegment(
  userId: string,
  threadId: string,
  settings: Settings,
  report: CapturePassReport,
): Promise<void> {
  const segments = await listThreadSegmentsByThread({ threadId, modelId: EMBEDDING_MODEL_ID });
  const newest = segments.at(-1);
  if (!newest) return;

  const rows = await listMessagesByThread({ threadId });
  const turns = unsettledTurns(rows, newest.startMessageId);
  const through = turns.at(-1)?.userMessage;
  if (!through) return;
  const pointer = (await capturePointersOf([newest.id])).get(newest.id) ?? null;
  if (pointer !== null && through.createdAt.getTime() <= pointer.getTime()) return;

  await readSegment(
    userId,
    settings,
    {
      segmentId: newest.id,
      turns,
      capturedThroughAt: pointer,
      spendMessageId: through.id,
      throughAt: through.createdAt,
    },
    report,
  );
}

async function captureEverythingUnread(
  userId: string,
  threadId: string,
): Promise<CapturePassReport> {
  const settings = await getUserSettings({ userId });
  if (!settings.memoryEnabled) return emptyReport(false);
  const report = await captureOwedSegments(userId, threadId, settings);
  if (report.failed > 0) return report;
  await captureNewestSegment(userId, threadId, settings, report);
  return report;
}

/**
 * Runs one capture pass over a thread's settled segments. Each pass is a
 * separate promise; overlapping passes on the same thread read the same
 * state and guard their pointer writes, so they do no more than re-check
 * each other.
 */
export function captureClosedSegments({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}): Promise<CapturePassReport> {
  return pooled(
    threadId,
    getUserSettings({ userId }).then((settings) => captureOwedSegments(userId, threadId, settings)),
  );
}

/**
 * The on-demand pass: everything in the thread not yet read, the newest
 * segment included even though it has not settled. Settled segments are
 * read first, as `captureClosedSegments` would.
 */
export function captureUnreadTurns({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}): Promise<CapturePassReport> {
  return pooled(threadId, captureEverythingUnread(userId, threadId));
}

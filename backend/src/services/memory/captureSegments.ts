import type { Message } from '@db/types';
import { capturePointersOf } from '@queries/memoryCaptureProgress/capturePointersOf';
import { recordSegmentCapture } from '@queries/memoryCaptureProgress/recordSegmentCapture';
import { upsertCaptureProgress } from '@queries/memoryCaptureProgress/upsertCaptureProgress';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import {
  findSegmentNeedingCaptureOrNull,
  listSegmentsNeedingCapture,
} from '@queries/threadSegments/listSegmentsNeedingCapture';
import { listThreadSegmentsByThread } from '@queries/threadSegments/listThreadSegmentsByThread';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { getUserSettings } from '@services/settingsService';
import type { SegmentToCapture } from '../../types/memory';
import { readFacts } from './readFacts';

type SegmentNeedingCapture = Awaited<ReturnType<typeof listSegmentsNeedingCapture>>[number];

type CaptureTurn = Parameters<typeof readFacts>[0]['turns'][number];

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
) {
  const start = rows.findIndex((row) => row.id === startMessageId);
  const end =
    settleMessageId === null ? rows.length : rows.findIndex((row) => row.id === settleMessageId);
  if (start < 0 || end <= start) return [];

  const live = rows.slice(start, end).filter((row) => !row.abandoned);
  const turns: CaptureTurn[] = [];
  for (let i = 0; i < live.length; i += 1) {
    const row = live[i];
    if (row?.role !== 'user') continue;
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
function unsettledTurns(rows: Message[], startMessageId: string) {
  const turns = segmentTurns(rows, startMessageId, null);
  return turns.at(-1)?.assistantReply === null ? turns.slice(0, -1) : turns;
}

/** What one capture pass did, for a caller that reports it to the user. */
interface CapturePassReport {
  /** False when the user switched memory off: nothing was read. */
  memoryEnabled: boolean;
  /**
   * Segments that held unread Turns when the pass reached them, short of
   * those another pass captured first.
   */
  owed: number;
  /** Segments whose capture failed; their pointers stay put for a retry. */
  failed: number;
  /** Why the first failed segment failed; null while none has. */
  failureCode: string | null;
  added: number;
  /** Known Facts restated or corrected, now superseded by the newer reading. */
  replaced: number;
}

function emptyReport(memoryEnabled: boolean): CapturePassReport {
  return { memoryEnabled, owed: 0, failed: 0, failureCode: null, added: 0, replaced: 0 };
}

/** One segment's read: its Turns, and where its pointer lands after. */
type SegmentRead = {
  segmentId: string;
  turns: CaptureTurn[];
  /** The segment's pointer as this pass found it. */
  capturedThroughAt: Date | null;
  /** The message the read's spend is recorded against. */
  spendMessageId: string;
  throughAt: Date;
};

type Settings = Awaited<ReturnType<typeof getUserSettings>>;

/** One capture pass over a thread: who it is for, their settings, and the report it adds to. */
type CapturePass = {
  userId: string;
  threadId: string;
  settings: Settings;
  report: CapturePassReport;
};

/** The read a settled segment owes: its Turns past the pointer, up to its settle row. */
function settledRead(rows: Message[], segment: SegmentNeedingCapture) {
  return {
    segmentId: segment.segmentId,
    turns: segmentTurns(rows, segment.startMessageId, segment.settleMessageId),
    capturedThroughAt: segment.capturedThroughAt,
    spendMessageId: segment.settleMessageId,
    throughAt: segment.settleMessageAt,
  };
}

/**
 * Reads one segment past its pointer, then stores its Facts and moves the
 * pointer together, unless another pass moved it first: that pass
 * captured these Turns, so this one owed nothing. Adds the outcome to the
 * report. False when the read failed.
 */
async function captureSegmentTurns({
  userId,
  settings,
  read,
  report,
}: {
  userId: string;
  settings: Settings;
  read: SegmentRead;
  report: CapturePassReport;
}) {
  const captured = await readFacts({
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
    report.owed += 1;
    report.failed += 1;
    report.failureCode ??= captured.code;
    return false;
  }
  const stored = await recordSegmentCapture({
    segmentId: read.segmentId,
    readFrom: read.capturedThroughAt,
    throughAt: read.throughAt,
    facts: captured.data,
  });
  if (!stored) return true;

  const replaced = captured.data.filter((fact) => fact.replacesFactId !== null).length;
  const added = captured.data.length - replaced;
  report.owed += 1;
  report.added += added;
  report.replaced += replaced;
  if (captured.data.length > 0) {
    console.log(
      `[memory capture] segment ${read.segmentId}: ${added} Fact(s) added, ${replaced} replaced`,
    );
  }
  return true;
}

/**
 * Captures one settled segment's Turns past its pointer. A segment that
 * owes nothing — not settled yet, already read through its settle row, or
 * gone — is a pass with nothing read, so capturing it twice stores nothing
 * extra. A user who switched memory off has the pointer jump to the settle
 * row instead: nothing is gathered, and nothing is deferred until memory
 * returns. When two passes read the same Turns at once, the first to
 * store its reading wins, and the other reports nothing owed.
 */
export async function captureSegment({
  userId,
  threadId,
  segmentId,
}: SegmentToCapture): Promise<CapturePassReport> {
  const settings = await getUserSettings({ userId });
  const report = emptyReport(settings.memoryEnabled);
  const segment = await findSegmentNeedingCaptureOrNull({ segmentId, modelId: EMBEDDING_MODEL_ID });
  if (!segment) return report;

  if (!settings.memoryEnabled) {
    await upsertCaptureProgress({ segmentId, throughAt: segment.settleMessageAt });
    return report;
  }

  const rows = await listMessagesByThread({ threadId });
  await captureSegmentTurns({ userId, settings, read: settledRead(rows, segment), report });
  return report;
}

/**
 * Every settled segment of the thread that owes a capture, oldest first,
 * stopping at the first failure: a later segment is read with what the
 * earlier ones taught the Memory.
 */
async function captureOwedSegments({ userId, threadId, settings, report }: CapturePass) {
  const owed = await listSegmentsNeedingCapture({ threadId, modelId: EMBEDDING_MODEL_ID });
  if (owed.length === 0) return;
  const rows = await listMessagesByThread({ threadId });
  for (const segment of owed) {
    const read = settledRead(rows, segment);
    if (!(await captureSegmentTurns({ userId, settings, read, report }))) return;
  }
}

/**
 * Reads the newest segment's answered Turns past its pointer, without
 * waiting for the segment to settle. The pointer then sits on the last
 * Turn read, so when the segment does settle its pass reads only what
 * came after, the rest riding along as context.
 */
async function captureNewestSegment({ userId, threadId, settings, report }: CapturePass) {
  const segments = await listThreadSegmentsByThread({ threadId, modelId: EMBEDDING_MODEL_ID });
  const newest = segments.at(-1);
  if (!newest) return;

  const rows = await listMessagesByThread({ threadId });
  const turns = unsettledTurns(rows, newest.startMessageId);
  const through = turns.at(-1)?.userMessage;
  if (!through) return;
  const pointer = (await capturePointersOf([newest.id])).get(newest.id) ?? null;
  if (pointer !== null && through.createdAt.getTime() <= pointer.getTime()) return;

  await captureSegmentTurns({
    userId,
    settings,
    read: {
      segmentId: newest.id,
      turns,
      capturedThroughAt: pointer,
      spendMessageId: through.id,
      throughAt: through.createdAt,
    },
    report,
  });
}

/**
 * The on-demand pass: everything in the thread not yet read, the newest
 * segment included even though it has not settled. Settled segments are
 * read first, oldest first, and a failure stops the pass there. A segment
 * another pass captures meanwhile counts as nothing owed.
 */
export async function captureUnreadTurns({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}): Promise<CapturePassReport> {
  const settings = await getUserSettings({ userId });
  const report = emptyReport(settings.memoryEnabled);
  if (!settings.memoryEnabled) return report;
  await captureOwedSegments({ userId, threadId, settings, report });
  if (report.failed > 0) return report;
  await captureNewestSegment({ userId, threadId, settings, report });
  return report;
}

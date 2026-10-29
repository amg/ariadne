import { db } from '@db/db';
import type { Message, ThreadSegment } from '@db/types';
import { capturePointersOf } from '@queries/memoryCaptureProgress/capturePointersOf';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { listThreadSegmentsByThread } from './listThreadSegmentsByThread';

/** A segment that owes a Fact capture, and where that capture should stop. */
interface SegmentNeedingCapture {
  segmentId: string;
  /** First user Message of the segment. */
  startMessageId: string;
  /** How far capture has already gone for this segment; null for a first pass. */
  capturedThroughAt: Date | null;
  /**
   * The arrival that settles the segment: the live drift fire that closed
   * it, or when that fire later died (edited or handed away), the opener of
   * the segment that succeeded it in the chain. The capture reads the Turns
   * up to it (not including it) and records its `created_at` as the
   * segment's `captured_through_at` pointer.
   */
  settleMessageId: string;
  settleMessageAt: Date;
}

type SettleCandidate = { messageId: string; at: Date };

interface ThreadChain {
  segments: ThreadSegment[];
  firesBySegment: Map<string, SettleCandidate[]>;
  messageById: Map<string, Message>;
  /** `captured_through_at` per segment that has been captured before. */
  pointerBySegment: Map<string, Date>;
}

type ListProps = {
  threadId: string;
  /** Which model's chain to read — one chain per embedding model runs. */
  modelId: string;
};

/** The live fires judged into each segment of the chain. */
async function firesBySegmentOf(segmentIds: string[]) {
  const rows = await db
    .selectFrom('analysis.segmentDriftLogs as l')
    .innerJoin('chat.messages as m', 'm.id', 'l.messageId')
    .where('l.segmentId', 'in', segmentIds)
    .where('l.verdict', '=', 'fire')
    .where('m.abandoned', '=', false)
    .select(['l.segmentId', 'm.id as messageId', 'm.createdAt as at'])
    .execute();
  const map = new Map<string, SettleCandidate[]>();
  for (const row of rows) {
    const fires = map.get(row.segmentId) ?? [];
    fires.push({ messageId: row.messageId, at: row.at });
    map.set(row.segmentId, fires);
  }
  return map;
}

/**
 * The row that settles a segment: the latest live fire judged into it, or
 * the opener of the segment cut after it, whichever is later. A drained
 * fire still counts through its cut, because the cut itself is the proof
 * the segment is over. Null while the segment is still drawing turns.
 */
function settleRowOf({
  segment,
  successor,
  chain,
}: {
  segment: ThreadSegment;
  successor: ThreadSegment | null;
  chain: ThreadChain;
}) {
  const candidates: SettleCandidate[] = [...(chain.firesBySegment.get(segment.id) ?? [])];
  if (successor) {
    const opener = chain.messageById.get(successor.startMessageId);
    if (opener) candidates.push({ messageId: opener.id, at: opener.createdAt });
  }
  const latest = candidates.reduce<SettleCandidate | null>(
    (top, row) => (top === null || row.at.getTime() > top.at.getTime() ? row : top),
    null,
  );
  if (latest === null) return null;
  const pointer = chain.pointerBySegment.get(segment.id)?.getTime() ?? Number.NEGATIVE_INFINITY;
  return latest.at.getTime() > pointer ? latest : null;
}

/** The segment's owed capture, or null when it owes none. */
function owedCaptureOrNull({
  segment,
  successor,
  chain,
}: {
  segment: ThreadSegment;
  successor: ThreadSegment | null;
  chain: ThreadChain;
}): SegmentNeedingCapture | null {
  const settle = settleRowOf({ segment, successor, chain });
  if (!settle) return null;
  return {
    segmentId: segment.id,
    startMessageId: segment.startMessageId,
    capturedThroughAt: chain.pointerBySegment.get(segment.id) ?? null,
    settleMessageId: settle.messageId,
    settleMessageAt: settle.at,
  };
}

/**
 * The thread's segments whose Fact capture is still owed, oldest first. A
 * segment owes one once it is settled (see `settleRowOf`) and its settle
 * row sits past the pointer Memory keeps for it; later turns reopen the
 * owing through the next settle row, and only they get read.
 */
export async function listSegmentsNeedingCapture({ threadId, modelId }: ListProps) {
  const segments = await listThreadSegmentsByThread({ threadId, modelId });
  if (segments.length === 0) return [];

  const messages = await listMessagesByThread({ threadId });
  const segmentIds = segments.map((segment) => segment.id);
  const chain: ThreadChain = {
    segments,
    firesBySegment: await firesBySegmentOf(segmentIds),
    messageById: new Map(messages.map((message) => [message.id, message])),
    pointerBySegment: await capturePointersOf(segmentIds),
  };

  return segments.flatMap(
    (segment, i) => owedCaptureOrNull({ segment, successor: segments[i + 1] ?? null, chain }) ?? [],
  );
}

/**
 * One segment's owed capture, as `listSegmentsNeedingCapture` would list
 * it, or null when it owes none or is gone. It reads that segment and the
 * one after it only, so its cost does not grow with the thread.
 */
export async function findSegmentNeedingCaptureOrNull({
  segmentId,
  modelId,
}: {
  segmentId: string;
  modelId: string;
}) {
  const segment = await db
    .selectFrom('analysis.threadSegments')
    .selectAll()
    .where('id', '=', segmentId)
    .where('modelId', '=', modelId)
    .executeTakeFirst();
  if (!segment) return null;
  // Compared in the database: a JavaScript date drops the microseconds Postgres keeps.
  const successor =
    (await db
      .selectFrom('analysis.threadSegments as next')
      .innerJoin('analysis.threadSegments as current', (join) =>
        join
          .onRef('current.threadId', '=', 'next.threadId')
          .onRef('current.modelId', '=', 'next.modelId'),
      )
      .selectAll('next')
      .where('current.id', '=', segmentId)
      .where((eb) =>
        eb.or([
          eb('next.createdAt', '>', eb.ref('current.createdAt')),
          eb.and([
            eb('next.createdAt', '=', eb.ref('current.createdAt')),
            eb('next.id', '>', eb.ref('current.id')),
          ]),
        ]),
      )
      .orderBy('next.createdAt', 'asc')
      .orderBy('next.id', 'asc')
      .limit(1)
      .executeTakeFirst()) ?? null;
  const opener = successor
    ? await db
        .selectFrom('chat.messages')
        .selectAll()
        .where('id', '=', successor.startMessageId)
        .executeTakeFirst()
    : undefined;
  const chain: ThreadChain = {
    segments: successor ? [segment, successor] : [segment],
    firesBySegment: await firesBySegmentOf([segment.id]),
    messageById: new Map(opener ? [[opener.id, opener]] : []),
    pointerBySegment: await capturePointersOf([segment.id]),
  };
  return owedCaptureOrNull({ segment, successor, chain });
}

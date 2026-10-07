import { db } from '@db/db';
import type { Message, ThreadSegment } from '@db/types';
import { capturePointersOf } from '@queries/memoryCaptureProgress/capturePointersOf';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { listThreadSegmentsByThread } from './listThreadSegmentsByThread';

/** A segment that owes a Fact capture, and where that capture should stop. */
export interface SegmentNeedingCapture {
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
  anchorMessageId: string;
  anchorAt: Date;
}

type AnchoredRows = { messageId: string; at: Date };

interface ThreadChain {
  segments: ThreadSegment[];
  firesBySegment: Map<string, AnchoredRows[]>;
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
async function firesBySegmentOf(segmentIds: string[]): Promise<Map<string, AnchoredRows[]>> {
  const rows = await db
    .selectFrom('analysis.segmentDriftLogs as l')
    .innerJoin('chat.messages as m', 'm.id', 'l.messageId')
    .where('l.segmentId', 'in', segmentIds)
    .where('l.verdict', '=', 'fire')
    .where('m.abandoned', '=', false)
    .select(['l.segmentId', 'm.id as messageId', 'm.createdAt as at'])
    .execute();
  const map = new Map<string, AnchoredRows[]>();
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
function anchorOrNull(
  segment: ThreadSegment,
  successor: ThreadSegment | null,
  chain: ThreadChain,
): AnchoredRows | null {
  const candidates: AnchoredRows[] = [...(chain.firesBySegment.get(segment.id) ?? [])];
  if (successor) {
    const opener = chain.messageById.get(successor.startMessageId);
    if (opener) candidates.push({ messageId: opener.id, at: opener.createdAt });
  }
  const latest = candidates.reduce<AnchoredRows | null>(
    (top, row) => (top === null || row.at.getTime() > top.at.getTime() ? row : top),
    null,
  );
  if (latest === null) return null;
  const pointer = chain.pointerBySegment.get(segment.id)?.getTime() ?? Number.NEGATIVE_INFINITY;
  return latest.at.getTime() > pointer ? latest : null;
}

/**
 * The thread's segments whose Fact capture is still owed, oldest first. A
 * segment owes one once it is settled (see `anchorOrNull`) and its settle
 * row sits past the pointer Memory keeps for it; later turns reopen the
 * owing through the next settle row, and only they get read.
 */
export async function listSegmentsNeedingCapture({
  threadId,
  modelId,
}: ListProps): Promise<SegmentNeedingCapture[]> {
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

  const results: SegmentNeedingCapture[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (!segment) break;
    const anchor = anchorOrNull(segment, segments[i + 1] ?? null, chain);
    if (!anchor) continue;
    results.push({
      segmentId: segment.id,
      startMessageId: segment.startMessageId,
      capturedThroughAt: chain.pointerBySegment.get(segment.id) ?? null,
      anchorMessageId: anchor.messageId,
      anchorAt: anchor.at,
    });
  }
  return results;
}

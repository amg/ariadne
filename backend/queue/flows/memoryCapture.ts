import { publish } from '@services/events';
import type { SegmentToCapture } from '@services/memory';

/** A captured segment announces it, so whoever waits on its Facts can go on. */
export function whenSegmentCaptured({ userId, threadId, segmentId }: SegmentToCapture): void {
  publish({ kind: 'memory-captured', userId, threadId, segmentId });
}

/**
 * A capture that stops trying on its own announces that too, so nobody
 * waits on Facts that will not come; the segment stays owed.
 */
export function whenSegmentCaptureAbandoned({
  userId,
  threadId,
  segmentId,
}: SegmentToCapture): void {
  publish({ kind: 'memory-capture-failed', userId, threadId, segmentId });
}

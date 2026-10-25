import type { DbExecutor, QueuedJob } from '@db/types';

/** The segment of a Thread whose Facts are owed a capture. */
export interface SegmentToCapture {
  userId: string;
  threadId: string;
  segmentId: string;
}

/**
 * Whether this deployment runs Memory. Off means nothing is captured and
 * no Seed is written or read; on carries how a closed segment's capture
 * is queued and found.
 */
export type MemoryFeature =
  | { kind: 'off' }
  | {
      kind: 'on';
      /** Queues the segment's capture; one already waiting for it absorbs the request. */
      enqueueMemoryCaptureSegment(segment: SegmentToCapture, trx?: DbExecutor): Promise<void>;
      /** The segment's capture in the queue; null when none is queued or it finished. */
      findMemoryCaptureSegmentJobOrNull(segmentId: string): Promise<QueuedJob | null>;
    };

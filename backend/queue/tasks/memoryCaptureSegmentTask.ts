import type { DbExecutor } from '@db/types';
import { enqueueJob } from '@queries/queue/enqueueJob';
import { type QueuedJob, findJobByKeyOrNull } from '@queries/queue/findJobByKey';
import { captureClosedSegments } from '@services/memory';
import type { SegmentToCapture } from '@services/memory';

export const MEMORY_CAPTURE_SEGMENT = 'memoryCaptureSegment';
const MAX_ATTEMPTS = 3;

declare global {
  namespace GraphileWorker {
    interface Tasks {
      memoryCaptureSegment: SegmentToCapture;
    }
  }
}

/** Queues a closed segment's capture; one already waiting for it absorbs the request. */
export function enqueueMemoryCaptureSegment(
  segment: SegmentToCapture,
  trx?: DbExecutor,
): Promise<void> {
  return enqueueJob(
    {
      task: MEMORY_CAPTURE_SEGMENT,
      payload: { ...segment },
      key: segment.segmentId,
      maxAttempts: MAX_ATTEMPTS,
    },
    trx,
  );
}

/** The segment's capture in the queue; null when none is queued or it finished. */
export function findMemoryCaptureSegmentJobOrNull(segmentId: string): Promise<QueuedJob | null> {
  return findJobByKeyOrNull({ task: MEMORY_CAPTURE_SEGMENT, key: segmentId });
}

/**
 * Captures the Facts this segment owes. The pass settles whatever is
 * closed by the segment's pointer, so capturing the segment twice leaves
 * nothing extra to store.
 */
export async function executeMemoryCaptureSegment({
  userId,
  threadId,
}: SegmentToCapture): Promise<void> {
  await captureClosedSegments({ userId, threadId });
}

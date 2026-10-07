import type { DbExecutor } from '@db/types';
import { enqueueJob } from '@queries/queue/enqueueJob';
import { type QueuedJob, findJobByKeyOrNull } from '@queries/queue/findJobByKey';
import { type SegmentToCapture, captureSegment } from '@services/memory';
import { TaskFailure } from '../errors';

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
 * Captures the Facts this segment owes past its pointer and resolves with
 * the segment once everything it owed is read. A failed read throws with
 * its cause, so the queue retries what a retry can fix and gives up at
 * once on what it cannot; the pointer stays put until a read succeeds. A
 * segment that owes nothing, gone or already read, is a capture with
 * nothing to store, so running it twice stores nothing extra.
 */
export async function captureMemorySegment(segment: SegmentToCapture): Promise<SegmentToCapture> {
  const report = await captureSegment(segment);
  if (report.failed > 0) {
    throw new TaskFailure(
      report.failureCode ?? 'capture_failed',
      `segment ${segment.segmentId} could not be read`,
    );
  }
  return segment;
}

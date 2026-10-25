import type { DbExecutor, QueuedJob } from '@db/types';
import { enqueueJob } from '@queries/queue/enqueueJob';
import { findJobByKey } from '@queries/queue/findJobByKey';
import { captureSegment } from '@services/memory';
import type { SegmentToCapture } from '../../src/types/memory';
import { MAX_ATTEMPTS, TaskFailure } from '../errors';

export const MEMORY_CAPTURE_SEGMENT = 'memoryCaptureSegment';

declare global {
  namespace GraphileWorker {
    interface Tasks {
      memoryCaptureSegment: SegmentToCapture;
    }
  }
}

/** Queues a closed segment's capture; one already waiting for it absorbs the request. */
export function enqueueMemoryCaptureSegment(segment: SegmentToCapture, trx?: DbExecutor) {
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
  return findJobByKey({ task: MEMORY_CAPTURE_SEGMENT, key: segmentId });
}

/**
 * Captures the Facts this segment owes past its pointer and resolves with
 * the segment once everything it owed is read. A failed read throws with
 * its cause, so the queue retries what a retry can fix and gives up at
 * once on what it cannot; the pointer stays put until a read succeeds. A
 * segment that owes nothing, gone or already read, is a capture with
 * nothing to store, so running it twice stores nothing extra.
 */
export async function captureMemorySegment(segment: SegmentToCapture) {
  const report = await captureSegment(segment);
  if (report.failed > 0) {
    throw new TaskFailure(
      report.failureCode ?? 'capture_failed',
      `segment ${segment.segmentId} could not be read`,
    );
  }
  return segment;
}

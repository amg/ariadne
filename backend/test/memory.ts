import {
  enqueueMemoryCaptureSegment,
  findMemoryCaptureSegmentJobOrNull,
} from '@queue/tasks/memoryCaptureSegmentTask';
import type { MemoryFeature } from '../src/types/memory';

/** A deployment running Memory, capturing through the real queue. */
export const memoryOn: MemoryFeature = {
  kind: 'on',
  enqueueMemoryCaptureSegment,
  findMemoryCaptureSegmentJobOrNull,
};

/** A deployment without Memory. */
export const memoryOff: MemoryFeature = { kind: 'off' };

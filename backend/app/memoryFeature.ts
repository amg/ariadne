import {
  enqueueMemoryCaptureSegment,
  findMemoryCaptureSegmentJobOrNull,
} from '@queue/tasks/memoryCaptureSegmentTask';
import type { MemoryFeature } from '../src/types/memory';
import type { FeatureFlags } from './types';

/** The Memory decision the deployment's flags make, as the value flows receive. */
export function memoryFeatureOf(flags: FeatureFlags): MemoryFeature {
  return flags.memory
    ? { kind: 'on', enqueueMemoryCaptureSegment, findMemoryCaptureSegmentJobOrNull }
    : { kind: 'off' };
}

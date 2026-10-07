import type { FeatureFlags } from '@config/features';
import {
  enqueueMemoryCaptureSegment,
  findMemoryCaptureSegmentJobOrNull,
} from '@queue/tasks/memoryCaptureSegmentTask';
import type { MemoryFeature } from '@services/memory';

/** The Memory decision the deployment's flags make, as the value flows receive. */
export function memoryFeatureOf(flags: FeatureFlags): MemoryFeature {
  return flags.memory
    ? { kind: 'on', enqueueMemoryCaptureSegment, findMemoryCaptureSegmentJobOrNull }
    : { kind: 'off' };
}

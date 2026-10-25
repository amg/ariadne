import { z } from 'zod';
import { recordKind } from './versioned.ts';

/** The host as one reading saw it. Swap-in and swap-out are cumulative since boot. */
export const hostSampleSchema = z.object({
  at: z.string(),
  cpuPercent: z.number(),
  perCorePercent: z.array(z.number()),
  memoryAvailableBytes: z.number(),
  memoryUsedPercent: z.number(),
  swapUsedBytes: z.number(),
  swapInBytes: z.number(),
  swapOutBytes: z.number(),
  loadAverage1: z.number(),
});
export type HostSample = z.infer<typeof hostSampleSchema>;
export const hostSampleRecords = recordKind('host-sample', hostSampleSchema);

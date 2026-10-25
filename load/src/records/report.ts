import { z } from 'zod';
import { instant } from './instant.ts';
import { REQUEST_KINDS } from './request.ts';
import { recordKind } from './versioned.ts';

const stretch = z.object({ startedAt: instant, endedAt: instant });

/** When a generator's users came up, held, and wound down; each stretch as it actually ran. */
const phasesSchema = z.object({
  ramp: stretch,
  hold: stretch,
  rampDown: stretch,
});
export type Phases = z.infer<typeof phasesSchema>;

/**
 * What a generator prints when it finishes. `requests` is how many
 * request lines it wrote, in all and by kind, so a copy of those lines
 * can be checked against it. `interrupted` marks a generator that was told
 * to stop before its plan ended; its `phases` are the ones it ran, and the
 * one it was in ended when it was told to stop. `phases` is null for a
 * generator that only seeds accounts.
 */
export const reportSchema = z.object({
  runId: z.string(),
  generator: z.number(),
  attempt: z.number().int(),
  startedAt: z.string(),
  endedAt: z.string(),
  interrupted: z.boolean().default(false),
  requests: z.object({
    total: z.number().int(),
    byKind: z.partialRecord(z.enum(REQUEST_KINDS), z.number().int()),
  }),
  phases: phasesSchema.nullable(),
});
export type Report = z.infer<typeof reportSchema>;
export const reportRecords = recordKind('report', reportSchema);

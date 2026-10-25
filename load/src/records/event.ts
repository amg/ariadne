import { z } from 'zod';
import { instant } from './instant.ts';
import { recordKind } from './versioned.ts';

/** Why a generator stopped: it finished its plan, or the run ended it early. */
export const STOP_REASONS = ['finished', 'guard', 'interrupted', 'failed', 'timed-out'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/**
 * What the reason the load command gives ECS starts with when it stops a
 * generator's task because the run is ending. A stop for that reason can
 * then be told from one made by anyone else.
 */
export const STOPPED_FOR_RUN_END = 'The load command stopped this generator';

/** Something that happened during a run, which no sampled series shows. */
export const eventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run-started'), at: instant }),
  z.object({
    kind: z.literal('run-ended'),
    at: instant,
    outcome: z.enum(['finished', 'guard', 'interrupted', 'failed']),
  }),
  z.object({ kind: z.literal('process-started'), at: instant, name: z.string(), task: z.string() }),
  z.object({ kind: z.literal('process-stopped'), at: instant, name: z.string() }),
  z.object({
    kind: z.literal('generator-launched'),
    at: instant,
    generator: z.number().int(),
    attempt: z.number().int(),
    firstUser: z.number().int(),
    userCount: z.number().int(),
    task: z.string(),
    spot: z.boolean(),
    /** When the plan has the ramp and the hold end; null for a generator with no ramp or hold. */
    planned: z.object({ rampEndsAt: instant, holdEndsAt: instant }).nullable(),
  }),
  z.object({
    kind: z.literal('generator-stopped'),
    at: instant,
    generator: z.number().int(),
    attempt: z.number().int(),
    reason: z.enum(STOP_REASONS),
    detail: z.string().nullable(),
    /** When the generator was told to stop, which is earlier than when it had stopped; null when the record does not say. */
    toldToStopAt: instant.nullable().default(null),
    /** Whether the run's end is what stopped it, so that its slice was not lost but ended with the run. */
    stoppedForRunEnd: z.boolean().default(false),
    /** The attempt that took over this one's users, when one did. */
    replacedByAttempt: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal('guard-tripped'),
    at: instant,
    line: z.string(),
    observed: z.number(),
    limit: z.number(),
    message: z.string(),
  }),
]);
export type RunEvent = z.infer<typeof eventSchema>;
export const eventRecords = recordKind('event', eventSchema);

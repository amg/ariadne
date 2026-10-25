import { z } from 'zod';
import { id } from './id.ts';
import type { Wire } from './wire.ts';

/** The Drift gate's reading of one arrival: `muted` in the cold start, `fire` when it pauses the arrival. */
export const GATE_VERDICTS = ['muted', 'pass', 'fire'] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];

/** Which channel fired: at once on one reading, or over several. */
export const FIRE_CHANNELS = ['immediate', 'slow'] as const;
export type FireChannel = (typeof FIRE_CHANNELS)[number];

/** The gate's verdict on one user arrival. */
export const driftVerdictSchema = z.object({
  verdict: z.enum(GATE_VERDICTS),
  fireChannel: z.enum(FIRE_CHANNELS).nullable(),
});
export type MessageDriftVerdict = Wire<typeof driftVerdictSchema>;

/** The verdict as the reply stream carries it, naming the arrival it judged. */
export const streamVerdictSchema = driftVerdictSchema.extend({ messageId: id });
export type StreamVerdict = Wire<typeof streamVerdictSchema>;

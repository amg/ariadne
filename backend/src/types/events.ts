import { FIRE_CHANNELS } from '@ari/lib/api/schemas/common/driftGate';
import { z } from 'zod';

/** Who an event is for: its user, and the Thread it happened in. */
const eventScope = { userId: z.string(), threadId: z.string() };

/** News for a user that happened outside any request of theirs. */
export const serverEventSchema = z.discriminatedUnion('kind', [
  /** The Drift gate judged an arrival clear; null when the gate is switched off. */
  z.object({
    kind: z.literal('verdict-ok'),
    ...eventScope,
    messageId: z.string(),
    verdict: z.enum(['pass', 'muted']).nullable(),
  }),
  /** The Drift gate fired on an arrival, which now waits for the user's choice. */
  z.object({
    kind: z.literal('verdict-paused'),
    ...eventScope,
    messageId: z.string(),
    fireChannel: z.enum(FIRE_CHANNELS).nullable(),
  }),
  /** The Drift gate could not judge an arrival and has stopped trying on its own. */
  z.object({ kind: z.literal('gate-failed'), ...eventScope, messageId: z.string() }),
  /** A Thread received its title; carries the title it now bears. */
  z.object({ kind: z.literal('thread-titled'), ...eventScope, title: z.string() }),
  /** A segment's Facts were captured, as far as the segment had settled. */
  z.object({ kind: z.literal('memory-captured'), ...eventScope, segmentId: z.string() }),
  /** A segment's capture stopped trying on its own; its Facts stay owed. */
  z.object({ kind: z.literal('memory-capture-failed'), ...eventScope, segmentId: z.string() }),
]);

export type ServerEvent = z.infer<typeof serverEventSchema>;

import { z } from 'zod';
import { FIRE_CHANNELS } from '../common/driftGate.ts';
import { endpoint } from '../common/endpoint.ts';
import { id } from '../common/id.ts';
import type { Wire } from '../common/wire.ts';

const arrival = { threadId: id, messageId: id };
const segment = { threadId: id, segmentId: id };

/**
 * News the push stream sends, one kind per event. Each SSE frame is named
 * by the event's kind, and its data is the event as JSON.
 */
export const serverEventSchema = z.discriminatedUnion('kind', [
  /** The gate judged an arrival clear; the verdict is null while the gate is off. */
  z.object({
    kind: z.literal('verdict-ok'),
    ...arrival,
    verdict: z.enum(['pass', 'muted']).nullable(),
  }),
  /** The gate fired on an arrival, which now waits for the user's choice. */
  z.object({
    kind: z.literal('verdict-paused'),
    ...arrival,
    fireChannel: z.enum(FIRE_CHANNELS).nullable(),
  }),
  /** The gate could not judge an arrival and stopped trying. */
  z.object({ kind: z.literal('gate-failed'), ...arrival }),
  z.object({ kind: z.literal('thread-titled'), threadId: id, title: z.string() }),
  /** A segment's Facts were captured, as far as the segment had settled. */
  z.object({ kind: z.literal('memory-captured'), ...segment }),
  /** A segment's capture stopped trying; its Facts stay owed. */
  z.object({ kind: z.literal('memory-capture-failed'), ...segment }),
]);
export type ServerEvent = Wire<typeof serverEventSchema>;
export type ServerEventKind = ServerEvent['kind'];

/** Every kind of event the push stream sends. */
export const SERVER_EVENT_KINDS: readonly ServerEventKind[] = serverEventSchema.options.map(
  (option) => option.shape.kind.value,
);

/**
 * Users whose push streams break at the same moment come back spread evenly
 * over this many milliseconds. Left to come back together, they would
 * arrive as one wave.
 */
export const PUSH_RECONNECT_SPREAD_MS = 5_000;

/**
 * The push stream: one long-lived SSE stream per tab. On connect it sends
 * the current state of the user's arrivals, then news as it happens.
 */
export const events = endpoint({
  method: 'GET',
  path: '/api/events',
  replies: { 200: 'stream' },
});

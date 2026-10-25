import { z } from 'zod';
import { instant } from './instant.ts';
import { recordKind } from './versioned.ts';

/** The kinds of request a virtual user makes. */
export const REQUEST_KINDS = [
  'signup',
  'signin',
  'thread',
  'chat',
  'chat-continue',
  'push',
  'refresh',
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/**
 * How a request ended. `held` and `dropped` belong to a push stream: the
 * generator closed it at the run's end, or the server ended it first.
 * `expired` is a request the server turned away because the session's
 * access token had run out; the user refreshes and sends it again.
 * `stopped` is a request the generator cut short because it was told to stop.
 */
const REQUEST_OUTCOMES = [
  'ok',
  'streamed',
  'paused',
  'still-checking',
  'conflict',
  'refused',
  'expired',
  'held',
  'dropped',
  'stopped',
  'failed',
] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];

/**
 * One request a virtual user made. `startedAt` is the wall clock at the
 * start; the two durations come from a monotonic clock. `status` is null
 * when no response arrived. A push stream is written when it ends, and
 * its `totalMs` is how long it stayed open.
 */
export const requestSchema = z.object({
  run: z.string(),
  generator: z.number().int(),
  attempt: z.number().int(),
  user: z.number().int(),
  kind: z.enum(REQUEST_KINDS),
  startedAt: instant,
  firstByteMs: z.number(),
  totalMs: z.number(),
  status: z.number().int().nullable(),
  outcome: z.enum(REQUEST_OUTCOMES),
  errorCode: z.string().nullable(),
});
export type RequestLine = z.infer<typeof requestSchema>;

/** Whether a request was a chat the user waited on, and so counts toward the first byte. */
export const isChat = (line: RequestLine) => line.kind === 'chat' || line.kind === 'chat-continue';
export const requestRecords = recordKind('request', requestSchema);

/** A generator's running state at one moment, written every few seconds. */
const stateSchema = z.object({
  run: z.string(),
  generator: z.number().int(),
  attempt: z.number().int(),
  at: instant,
  usersSignedIn: z.number().int(),
  pushStreamsOpen: z.number().int(),
  chattersActive: z.number().int(),
});
export type StateLine = z.infer<typeof stateSchema>;
export const stateRecords = recordKind('state', stateSchema);

import { z } from 'zod';

/**
 * The backend's own records: one log line per request to the API, per
 * chat request, per attempt at a queued job, and one of its state every
 * few seconds. Each sits under an `appRecord` key in the log and carries
 * no message text or payload.
 */

/** UTC with milliseconds, as `Date.toISOString` writes it. */
const instant = z.iso.datetime({ precision: 3 });

/**
 * The copy of the backend that wrote a record: its ECS task id on
 * aws-prod, or its host and process elsewhere. Null where the writer did
 * not name its copy.
 */
const copy = z.string().nullable().default(null);

/** What the Drift gate answered an arrival, or that it was not asked. */
export const EXCHANGE_VERDICTS = ['muted', 'pass', 'fire', 'failed', 'pending', 'off'] as const;
export type ExchangeVerdict = (typeof EXCHANGE_VERDICTS)[number];

/**
 * How a chat request ended. A request refused before any reply started is
 * `refused`, with its code. One whose client left before any reply started
 * is `gone`.
 */
export const EXCHANGE_OUTCOMES = [
  'completed',
  'interrupted',
  'timed-out',
  'failed',
  'paused',
  'gate-pending',
  'gate-failed',
  'refused',
  'gone',
] as const;
export type ExchangeOutcome = (typeof EXCHANGE_OUTCOMES)[number];

/**
 * One chat request, written as it ends. `arrivedAt` is the wall clock when
 * it arrived. Every duration counts from then on a monotonic clock, and a
 * duration is null when its moment never came.
 */
export const exchangeRecordSchema = z.object({
  kind: z.literal('exchange'),
  copy,
  userId: z.string(),
  trigger: z.enum(['submit', 'retry']),
  arrivedAt: instant,
  /** What the gate answered; null when the request did not wait on it. */
  verdict: z.enum(EXCHANGE_VERDICTS).nullable(),
  /**
   * Whether the verdict was already stored when a retry began, so the
   * request replayed it and the gate judged nothing for it.
   */
  verdictReplayed: z.boolean().default(false),
  verdictAfterMs: z.number().nullable(),
  firstTokenAfterMs: z.number().nullable(),
  endedAfterMs: z.number(),
  outcome: z.enum(EXCHANGE_OUTCOMES),
  errorCode: z.string().nullable(),
  /** The reply's Message; null when no reply was started. */
  assistantMessageId: z.string().nullable(),
});
export type ExchangeRecord = z.infer<typeof exchangeRecordSchema>;

/**
 * The verdict the gate judged for an exchange, which is counted once.
 * Null when it judged none: the request never waited on the gate, or a
 * retry replayed a verdict already stored.
 */
export function judgedVerdictOrNull(exchange: Pick<ExchangeRecord, 'verdict' | 'verdictReplayed'>) {
  return exchange.verdictReplayed ? null : exchange.verdict;
}

/**
 * One attempt at a queued job, written as it ends. `queuedAt` is when the
 * attempt was due to run, which a retry pushes back.
 */
export const jobRecordSchema = z.object({
  kind: z.literal('job'),
  copy,
  task: z.string(),
  jobId: z.string(),
  attempt: z.number().int(),
  queuedAt: instant,
  startedAt: instant,
  finishedAt: instant,
  durationMs: z.number(),
  outcome: z.enum(['succeeded', 'failed', 'timed-out']),
  /** Whether a failure is worth retrying; null for an attempt that succeeded. */
  errorClass: z.enum(['fatal', 'recoverable']).nullable(),
  errorCode: z.string().nullable(),
});
export type JobRecord = z.infer<typeof jobRecordSchema>;

/** A figure of a state record: null where the copy does not measure it. */
const nullableFigure = (figure: z.ZodNumber = z.number()) => figure.nullable().default(null);

/**
 * One request to the API, written as its response ends. `route` is the
 * route's pattern, with its parameters unfilled, so requests to one
 * endpoint share a route whoever they are for. It is null for a request
 * that no route took.
 */
export const requestRecordSchema = z.object({
  kind: z.literal('request'),
  copy,
  endedAt: instant,
  method: z.string(),
  route: z.string().nullable(),
  statusCode: z.number().int(),
  /** How long the server took from receiving the request to ending the response. */
  durationMs: z.number(),
});
export type RequestRecord = z.infer<typeof requestRecordSchema>;

/**
 * What one copy of the backend is carrying at a moment. A figure is null
 * where that copy does not measure it.
 */
export const stateRecordSchema = z.object({
  kind: z.literal('state'),
  copy,
  at: instant,
  pushStreamsOpen: z.number().int().nullable(),
  /** How long the oldest job due to run has waited; 0 when none waits. */
  oldestJobWaitMs: z.number().nullable(),
  /** How long the copy's one thread was kept from its work, since the last state record; null when nothing was sampled. */
  eventLoopDelayP99Ms: nullableFigure(),
  /** The memory the copy's code is holding. */
  heapUsedBytes: nullableFigure(),
  /** The memory the copy's process holds in all. */
  residentBytes: nullableFigure(),
  /** Database connections lent out from the copy's pool. */
  dbConnectionsInUse: nullableFigure(z.number().int()),
  /** Requests for a database connection waiting for one to be free. */
  dbConnectionsWaiting: nullableFigure(z.number().int()),
  /** Jobs the copy is running now; null for a copy that does not work the queue. */
  workerSlotsBusy: nullableFigure(z.number().int()),
  /** How many jobs the copy runs side by side at most. */
  workerSlots: nullableFigure(z.number().int()),
  /** Sends and subscriptions between copies that failed, since the last state record. */
  pushBusFailures: nullableFigure(z.number().int()),
});
export type StateRecord = z.infer<typeof stateRecordSchema>;

export const appRecordSchema = z.discriminatedUnion('kind', [
  exchangeRecordSchema,
  jobRecordSchema,
  requestRecordSchema,
  stateRecordSchema,
]);
export type AppRecord = z.infer<typeof appRecordSchema>;
export type AppRecordKind = AppRecord['kind'];

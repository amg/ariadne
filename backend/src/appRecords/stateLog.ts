import { env } from '../config/env';
import { logger } from '../logger';
import { logAppRecord } from './records';

/** How long a state record waits for a measure before it is written without it. */
export const STATE_MEASURE_TIMEOUT_MS = 2_000;

/** What a copy of the backend can measure of itself; a measure it lacks is left out. */
type StateMeasures = {
  /** The push streams open on this copy. */
  pushStreamsOpen?: () => number;
  /** How long the event loop was held up since the measure was last asked, in milliseconds; null when nothing was sampled. */
  eventLoopDelayP99Ms?: () => number | null;
  /** The memory this copy holds. */
  memory?: () => { heapUsedBytes: number; residentBytes: number };
  /** The connections this copy's database pool has lent out, and the requests waiting for one. */
  databaseConnections?: () => { inUse: number; waiting: number };
  /** The jobs this copy runs now, and how many it runs side by side at most. */
  workerSlots?: () => { busy: number; total: number };
  /** The sends and subscriptions between copies that failed since the measure was last asked. */
  pushBusFailures?: () => number;
  /**
   * How long the oldest job due to run has waited, for a copy that works
   * the queue. It is given how long it may take, and should give up after.
   */
  oldestJobWaitMs?: (limit: { timeoutMs: number }) => Promise<number>;
};

/**
 * Logs a state record now and then every `STATE_LOG_INTERVAL_SECONDS`,
 * until stopped. A record waits at most `STATE_MEASURE_TIMEOUT_MS` for a
 * measure, and is written with that figure null when it has to stop
 * waiting. While a measure is still running, later records are skipped,
 * so slow measures never pile up. A measure that fails is logged and left
 * null; it never stops the logging or the process. A measure that counts
 * since it was last asked is asked once for each record written, and not
 * for a record that is skipped.
 */
export function keepLoggingState(measures: StateMeasures): () => void {
  let measuring = false;
  let stopped = false;

  const measuredJobWaitMsOrNull = async (): Promise<number | null> => {
    const measure = measures.oldestJobWaitMs;
    if (measure === undefined) return null;
    measuring = true;
    // Started inside a promise, so a measure that throws at once still clears the flag.
    const measured = Promise.resolve()
      .then(() => measure({ timeoutMs: STATE_MEASURE_TIMEOUT_MS }))
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'could not measure how long the oldest job has waited');
        return null;
      })
      .finally(() => {
        measuring = false;
      });
    return Promise.race([measured, nullAfter(STATE_MEASURE_TIMEOUT_MS)]);
  };

  const record = async (): Promise<void> => {
    if (measuring || stopped) return;
    const at = new Date().toISOString();
    const quick = figuresReadAtOnce(measures);
    const oldestJobWaitMs = await measuredJobWaitMsOrNull();
    if (stopped) return;
    logAppRecord({ kind: 'state', at, oldestJobWaitMs, ...quick });
  };

  void record();
  // Unref'd so the recording never holds the process open at shutdown.
  const timer = setInterval(() => void record(), env.STATE_LOG_INTERVAL_SECONDS * 1_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * The figures a copy can read without waiting. A figure is null where the
 * copy has no measure for it. It is also null where its measure failed.
 */
function figuresReadAtOnce(measures: StateMeasures) {
  const memory = measuredOrNull('memory', measures.memory);
  const connections = measuredOrNull('database connections', measures.databaseConnections);
  const slots = measuredOrNull('worker slots', measures.workerSlots);
  return {
    pushStreamsOpen: measuredOrNull('push streams', measures.pushStreamsOpen),
    eventLoopDelayP99Ms: measuredOrNull('event loop delay', measures.eventLoopDelayP99Ms),
    heapUsedBytes: memory?.heapUsedBytes ?? null,
    residentBytes: memory?.residentBytes ?? null,
    dbConnectionsInUse: connections?.inUse ?? null,
    dbConnectionsWaiting: connections?.waiting ?? null,
    workerSlotsBusy: slots?.busy ?? null,
    workerSlots: slots?.total ?? null,
    pushBusFailures: measuredOrNull('push bus failures', measures.pushBusFailures),
  };
}

/** What a measure gives; null where there is no measure, or it fails, which is logged. */
function measuredOrNull<Figure>(what: string, measure: (() => Figure) | undefined): Figure | null {
  if (measure === undefined) return null;
  try {
    return measure();
  } catch (error) {
    logger.warn({ err: error }, `could not measure ${what}`);
    return null;
  }
}

/** Resolves to null after `ms`, without holding the process open. */
function nullAfter(ms: number): Promise<null> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), ms).unref();
  });
}

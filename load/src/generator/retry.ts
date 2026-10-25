import { PUSH_RECONNECT_SPREAD_MS } from '@ari/lib/api/schemas/events/events';

/** The longest a refused or still-checking user waits before trying again. */
export const MAX_BACKOFF_SECONDS = 60;

/** The first wait after a failure; each further failure in a row doubles it. */
const FIRST_RETRY_SECONDS = 1;

/**
 * Users whose push streams were cut off together, as when a server task
 * restarts, come back spread evenly over this many seconds. Left to come
 * back at one moment, they would arrive as a wave.
 */
export const RECONNECT_SPREAD_SECONDS = PUSH_RECONNECT_SPREAD_MS / 1_000;

/**
 * Runs `work` until it succeeds, pausing longer after each failure.
 * Resolves to null if `signal` aborts first.
 */
export async function retried<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T | null> {
  for (let failures = 0; !signal.aborted; failures += 1) {
    try {
      return await work();
    } catch {
      await pause(backoffSeconds(failures + 1), signal);
    }
  }
  return null;
}

/**
 * The pause after `failures` failures in a row. With none, as after a push
 * stream that dropped, it is any time up to the reconnect spread. Otherwise
 * it is one second, doubling with each further failure up to a minute, and
 * each pause is spread over its upper half. Either way, users cut off
 * together do not all return together.
 */
export function backoffSeconds(failures: number) {
  if (failures === 0) return RECONNECT_SPREAD_SECONDS * Math.random();
  const ceiling = Math.min(FIRST_RETRY_SECONDS * 2 ** (failures - 1), MAX_BACKOFF_SECONDS);
  return ceiling * (0.5 + Math.random() / 2);
}

/** Resolves after `seconds`, or at once when `signal` aborts. */
export function pause(seconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, seconds * 1_000);
    signal.addEventListener('abort', stop, { once: true });
  });
}

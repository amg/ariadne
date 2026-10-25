import type { ProcessRole } from '../types/config';

/** The connections the app's pool keeps for requests and everything else that is not a queue job. */
const BASE_CONNECTIONS = 10;

/** The connections the queue engine keeps for itself, beyond one per job. */
const QUEUE_SPARE_CONNECTIONS = 2;

/**
 * How many connections the app's pool may open: the base, plus one for
 * every job the process runs side by side when it works the queue, so a
 * full set of jobs never waits on the pool.
 */
export function appPoolSize(role: ProcessRole, jobConcurrency: number) {
  return role === 'api' ? BASE_CONNECTIONS : BASE_CONNECTIONS + jobConcurrency;
}

/** How many connections the queue engine may open: one per job it runs side by side, and its spares. */
export function queuePoolSize(jobConcurrency: number) {
  return jobConcurrency + QUEUE_SPARE_CONNECTIONS;
}

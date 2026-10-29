import type { ProcessRole } from '../types/config';

/** The connections the app's pool keeps for requests and everything else that is not a queue job. */
const BASE_CONNECTIONS = 10;

/**
 * The connections an API copy's pool may open. A copy serves many chats
 * side by side, and each chat holds a connection a little longer while the
 * copy is busy, so the API gets more than the base.
 */
const API_CONNECTIONS = 40;

/** The connections the queue engine keeps for itself, beyond one per job. */
const QUEUE_SPARE_CONNECTIONS = 2;

/**
 * How many connections the app's pool may open. An API copy gets its own
 * fixed number. A process that works the queue gets the base, plus one for
 * every job it runs side by side, so a full set of jobs never waits on the
 * pool.
 */
export function appPoolSize(role: ProcessRole, jobConcurrency: number) {
  switch (role) {
    case 'api':
      return API_CONNECTIONS;
    case 'worker':
    case 'all':
      return BASE_CONNECTIONS + jobConcurrency;
    default: {
      const _check: never = role;
      return _check;
    }
  }
}

/** How many connections the queue engine may open: one per job it runs side by side, and its spares. */
export function queuePoolSize(jobConcurrency: number) {
  return jobConcurrency + QUEUE_SPARE_CONNECTIONS;
}

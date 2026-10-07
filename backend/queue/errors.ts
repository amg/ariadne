import { type JobErrorClass, taggedJobError } from '@queries/queue/jobError';

/**
 * A task's own failure, carrying the stable code of the service failure
 * behind it. Tasks throw it; the worker classifies it.
 */
export class TaskFailure extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message === undefined ? code : `${code}: ${message}`);
    this.name = 'TaskFailure';
    this.code = code;
  }
}

/** Codes that no retry can fix: the deployment or the job itself is wrong. */
const FATAL_CODES: ReadonlySet<string> = new Set(['provider_not_configured']);

/**
 * Provider answers that no retry can fix: rejected credentials, a model
 * that does not exist, a request the provider refuses to read.
 */
const FATAL_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422]);

function statusCodeOrNull(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return null;
  return typeof error.statusCode === 'number' ? error.statusCode : null;
}

/**
 * Whether a failed task is worth running again on its own (`recoverable`:
 * rate limits, a model still loading, timeouts, network faults) or must
 * wait for the operator (`fatal`: missing configuration, rejected
 * credentials, malformed input). Anything unrecognised is recoverable, so
 * it gets its remaining attempts.
 */
export function classifyTaskError(error: unknown): JobErrorClass {
  if (error instanceof TaskFailure) return FATAL_CODES.has(error.code) ? 'fatal' : 'recoverable';
  const status = statusCodeOrNull(error);
  return status !== null && FATAL_STATUSES.has(status) ? 'fatal' : 'recoverable';
}

/** The error a failed attempt is recorded with: its class first, then the reason. */
export function classifiedTaskError(error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(taggedJobError(classifyTaskError(error), reason));
}

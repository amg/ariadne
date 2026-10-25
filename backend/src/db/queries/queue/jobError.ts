import type { JobErrorClass } from '@db/types';

const TAG = /^\[(recoverable|fatal)\] /;

/** The error text a failed job stores: its class first, then the reason. */
export function taggedJobError(errorClass: JobErrorClass, reason: string) {
  return `[${errorClass}] ${reason}`;
}

/** The class a stored job error carries; null for untagged or absent errors. */
export function jobErrorClassOrNull(lastError: string | null) {
  const match = lastError === null ? null : TAG.exec(lastError);
  if (!match) return null;
  return match[1] === 'fatal' ? 'fatal' : 'recoverable';
}

/** The key a job merges duplicates on: its task first, so keys never collide. */
export function jobKeyOf(task: string, key: string) {
  return `${task}:${key}`;
}

import type { Message } from '@db/types';

/**
 * Index of the Thread's newest live user Message: the one a Retry, an Edit
 * or a starting Exchange targets, whether or not a reply grew beneath it.
 * Abandoned rows never count. -1 when the Thread has none.
 */
export function newestLiveUserIndex(rows: readonly Message[]): number {
  return rows.findLastIndex((row) => row.role === 'user' && !row.abandoned);
}

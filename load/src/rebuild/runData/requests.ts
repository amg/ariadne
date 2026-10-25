import type { RunData } from '../types.ts';

/** The request lines of every slice that has them. */
export function requestsOf(data: Pick<RunData, 'slices'>) {
  return data.slices.flatMap(({ requests }) => requests ?? []);
}

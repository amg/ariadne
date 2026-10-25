import { REQUEST_KINDS } from '../../records/index.ts';
import { compareText } from '../numbers.ts';
import { isCutAndReopenedIn, requestsOf } from '../runData/index.ts';
import type { FailureCount, RunData } from '../types.ts';

/**
 * The failed requests of the run, counted by kind, status and error code.
 * A push stream that was cut off and reopened within seconds is not a
 * failure: its user lost nothing they would notice.
 * Kinds come in the order a user meets them, then statuses in number
 * order with no response first, then error codes in text order.
 */
export function failureCounts(data: RunData) {
  const counts = new Map<string, FailureCount>();
  const reopened = isCutAndReopenedIn(data);
  for (const line of requestsOf(data)) {
    if (line.outcome !== 'failed' || reopened(line)) continue;
    const key = JSON.stringify([line.kind, line.status, line.errorCode]);
    const seen = counts.get(key);
    if (seen === undefined) {
      counts.set(key, {
        kind: line.kind,
        status: line.status,
        errorCode: line.errorCode,
        count: 1,
      });
    } else {
      seen.count += 1;
    }
  }
  return [...counts.values()].sort(
    (a, b) =>
      REQUEST_KINDS.indexOf(a.kind) - REQUEST_KINDS.indexOf(b.kind) ||
      (a.status ?? -1) - (b.status ?? -1) ||
      compareText(a.errorCode ?? '', b.errorCode ?? ''),
  );
}

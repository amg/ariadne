import { type Result, err } from '../../types/result';

/**
 * Bounded busy-backoff against DeepInfra's on-demand model pool —
 * provider-behaviour handling shared by the rewrite tier's two small
 * model calls (judge, rewrite). While an on-demand instance loads the
 * provider answers "Model busy, retry later": a retry hint from the
 * provider itself, so these calls (alone among the boundary calls)
 * honour retried attempts before failing over to their raw-only
 * fallback. The window is tuned to cover the observed cold-load
 * (~15s): five attempts on a four-second stride. Every other failure
 * fails over immediately — backoff only ever rides the provider's own
 * busy hint.
 */
export const ON_DEMAND_MAX_ATTEMPTS = 5;
export const ON_DEMAND_RETRY_DELAY_MS = 4000;
export const ON_DEMAND_BUSY_MARKER = 'Model busy';

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one attempt repeatedly until success, a non-busy failure, or the
 * attempt budget is spent. The attempt's error message must carry the
 * provider's detail (see judgeOnce/rewriteOnce) so the busy marker is
 * visible here.
 */
export async function withOnDemandBackoff<T>(
  attempt: () => Promise<Result<T>>,
): Promise<Result<T>> {
  let last: Result<T> = err('call_failed', 'The call never ran.');
  for (let tries = 1; tries <= ON_DEMAND_MAX_ATTEMPTS; tries += 1) {
    last = await attempt();
    const busy = last.type === 'error' && (last.message ?? '').includes(ON_DEMAND_BUSY_MARKER);
    if (last.type === 'success' || !busy || tries === ON_DEMAND_MAX_ATTEMPTS) return last;
    await sleepMs(ON_DEMAND_RETRY_DELAY_MS);
  }
  return last;
}

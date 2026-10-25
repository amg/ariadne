import { env } from '@config/env';

let busy = 0;

/**
 * Runs a job's work and counts the job as running until the work settles,
 * whether it succeeds or fails.
 */
export async function runningInSlot<Result>(work: () => Promise<Result>): Promise<Result> {
  busy += 1;
  try {
    return await work();
  } finally {
    busy -= 1;
  }
}

/** The jobs this process is running now, and how many it runs side by side at most. */
export function workerSlots() {
  return { busy, total: env.WORKER_JOB_CONCURRENCY };
}

import { type DeadJob, listDeadJobs } from '@queries/queue/listDeadJobs';
import { requeueJobs } from '@queries/queue/requeueJobs';

export interface RequeuedDeadJobs {
  /** Dead jobs now due again, each with all its attempts back. */
  requeued: DeadJob[];
  /**
   * Dead jobs left as they are because a newer job for the same key took
   * the work over; they hold no key any more.
   */
  superseded: DeadJob[];
}

/**
 * Makes every dead job due again with its attempts reset, except those a
 * newer job superseded.
 */
export async function requeueDeadJobs(): Promise<RequeuedDeadJobs> {
  const dead = await listDeadJobs();
  const owning = dead.filter((job) => job.key !== null);
  const superseded = dead.filter((job) => job.key === null);
  const requeuedIds = new Set(await requeueJobs(owning.map((job) => job.id)));
  return { requeued: owning.filter((job) => requeuedIds.has(job.id)), superseded };
}

import { listDeadJobs } from '@queries/queue/listDeadJobs';
import { requeueJobs } from '@queries/queue/requeueJobs';

/**
 * Makes every dead job due again with its attempts reset, except those a
 * newer job superseded.
 */
export async function requeueDeadJobs() {
  const dead = await listDeadJobs();
  const owning = dead.filter((job) => job.key !== null);
  const superseded = dead.filter((job) => job.key === null);
  const requeuedIds = new Set(await requeueJobs(owning.map((job) => job.id)));
  return { requeued: owning.filter((job) => requeuedIds.has(job.id)), superseded };
}

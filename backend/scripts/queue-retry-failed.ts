/**
 * Puts every dead queue job back in line with fresh attempts, then lists
 * what it re-queued. Dead jobs a newer job superseded are listed but left
 * alone: the newer job owns the work.
 *
 * Usage: npm run queue:retry-failed
 *        ENV_FILE=.env.prod npm run queue:retry-failed
 */
import '@config/dotenv';
import type { DeadJob } from '@queries/queue/listDeadJobs';
import { requeueDeadJobs } from '@queue/deadJobs';

function describedJob(job: DeadJob): string {
  const subject = job.key ?? `${job.task} (job ${job.id})`;
  return `  ${subject}, ${job.attempts} attempts: ${job.lastError ?? 'no error recorded'}`;
}

async function retryFailedJobs(): Promise<void> {
  const { requeued, superseded } = await requeueDeadJobs();
  console.log(`Re-queued ${requeued.length} dead job(s).`);
  for (const job of requeued) console.log(describedJob(job));
  if (superseded.length === 0) return;
  console.log(`Left ${superseded.length} superseded dead job(s); a newer job owns the work:`);
  for (const job of superseded) console.log(describedJob(job));
}

retryFailedJobs()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });

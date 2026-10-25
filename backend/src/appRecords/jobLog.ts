import { type JobRecord, elapsedMsSince, logAppRecord } from './records';

/** How an attempt ended, which is all the record is told besides the job. */
type AttemptEnding = Pick<JobRecord, 'outcome' | 'errorClass' | 'errorCode'>;

/**
 * Starts the log of an attempt at a job that has just begun. Calling the
 * result when the attempt ends writes its record.
 */
export function startJobLog(
  task: string,
  job: { id: string; attempts: number; run_at: Date },
): (ending: AttemptEnding) => void {
  const startedAt = new Date();
  const began = performance.now();
  return (ending) => {
    logAppRecord({
      kind: 'job',
      task,
      jobId: job.id,
      attempt: job.attempts,
      queuedAt: job.run_at.toISOString(),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: elapsedMsSince(began),
      ...ending,
    });
  };
}

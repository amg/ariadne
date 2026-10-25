import { db } from '@db/db';
import type { JobErrorClass } from '@db/types';
import { jobErrorClassOrNull } from './jobError';

interface DeadJob {
  id: string;
  task: string;
  key: string | null;
  attempts: number;
  errorClass: JobErrorClass | null;
  lastError: string | null;
  createdAt: Date;
}

/**
 * Jobs that ran out of attempts and are not running, oldest first. A dead
 * job whose key a newer job took over is included; it has no key left.
 */
export async function listDeadJobs(): Promise<DeadJob[]> {
  const rows = await db
    .selectFrom('queues.jobs')
    .select(['id', 'taskIdentifier', 'key', 'attempts', 'lastError', 'createdAt'])
    .where('lockedAt', 'is', null)
    .whereRef('attempts', '>=', 'maxAttempts')
    .orderBy('createdAt')
    .orderBy('id')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    task: row.taskIdentifier,
    key: row.key,
    attempts: row.attempts,
    errorClass: jobErrorClassOrNull(row.lastError),
    lastError: row.lastError,
    createdAt: row.createdAt,
  }));
}

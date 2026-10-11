import { env } from '@config/env';
import { db } from '@db/db';
import { QUEUE_SCHEMA } from '@queue/index';
import { useTestDb } from '@test/test-db';
import { type WorkerUtils, makeWorkerUtils } from 'graphile-worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STALE_LOCK_SECONDS, releaseStaleLocks } from './staleLocks';

useTestDb();

let utils: WorkerUtils;

beforeAll(async () => {
  utils = await makeWorkerUtils({ connectionString: env.DATABASE_URL, schema: QUEUE_SCHEMA });
});

afterAll(async () => {
  await utils.release();
});

/** A job held by `workerId` since `lockedSecondsAgo`, as a worker mid-task leaves it. */
async function jobHeldBy(workerId: string, lockedSecondsAgo: number): Promise<string> {
  const job = await utils.addJob('probeHeld', {});
  await sql`
    update queues._private_jobs
       set locked_by = ${workerId},
           locked_at = now() - make_interval(secs => ${lockedSecondsAgo})
     where id = ${job.id}
  `.execute(db);
  return job.id;
}

async function holderOf(jobId: string): Promise<string | null> {
  const row = await db
    .selectFrom('queues.jobs')
    .select('lockedBy')
    .where('id', '=', jobId)
    .executeTakeFirstOrThrow();
  return row.lockedBy;
}

describe('releaseStaleLocks', () => {
  it('frees a job locked for too long', async () => {
    const jobId = await jobHeldBy('worker-gone', STALE_LOCK_SECONDS + 10);

    await releaseStaleLocks(utils);

    expect(await holderOf(jobId)).toBeNull();
  });

  it('leaves a recently locked job with its worker', async () => {
    const jobId = await jobHeldBy('worker-busy', 1);

    await releaseStaleLocks(utils);

    expect(await holderOf(jobId)).toBe('worker-busy');
  });

  it('leaves a worker that took a job recently all of its jobs', async () => {
    const oldJobId = await jobHeldBy('pool-batched', STALE_LOCK_SECONDS + 10);
    const newJobId = await jobHeldBy('pool-batched', 1);

    await releaseStaleLocks(utils);

    expect(await holderOf(oldJobId)).toBe('pool-batched');
    expect(await holderOf(newJobId)).toBe('pool-batched');
  });
});

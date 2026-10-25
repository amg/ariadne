import { db } from '@db/db';
import { oldestDueJobWaitMs } from '@queries/queue/oldestDueJobWaitMs';
import { addJobDueAt } from '@test/queue';
import { useTestDb } from '@test/test-db';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

useTestDb();

const queue = (task: string, key: string, runAt: Date) => addJobDueAt({ task, key, runAt });
const LIMIT = { timeoutMs: 2_000 };

describe('oldestDueJobWaitMs', () => {
  it('is 0 when no job waits', async () => {
    expect(await oldestDueJobWaitMs({ tasks: ['waitProbe'], ...LIMIT })).toBe(0);
  });

  it('is how long the oldest job due has waited, whatever else is queued', async () => {
    await queue('waitProbe', 'old', new Date(Date.now() - 4_000));
    await queue('waitProbe', 'new', new Date(Date.now() - 1_000));

    const waited = await oldestDueJobWaitMs({ tasks: ['waitProbe'], ...LIMIT });

    expect(waited).toBeGreaterThanOrEqual(3_900);
    expect(waited).toBeLessThan(10_000);
  });

  it('does not count a job not yet due, or a task the caller does not work', async () => {
    await queue('waitProbe', 'later', new Date(Date.now() + 60_000));
    await queue('otherProbe', 'elsewhere', new Date(Date.now() - 4_000));

    expect(await oldestDueJobWaitMs({ tasks: ['waitProbe'], ...LIMIT })).toBe(0);
    expect(await oldestDueJobWaitMs({ tasks: [], ...LIMIT })).toBe(0);
  });

  it('gives up when the jobs table is held longer than it may wait', async () => {
    await db.transaction().execute(async (trx) => {
      await sql`lock table queues._private_jobs in access exclusive mode`.execute(trx);

      await expect(oldestDueJobWaitMs({ tasks: ['waitProbe'], timeoutMs: 200 })).rejects.toThrow(
        /statement timeout/,
      );
    });
  });
});

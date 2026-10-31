import { randomUUID } from 'node:crypto';
import { inTransaction } from '@queries/transaction/inTransaction';
import { enqueueThreadGenerateTitle } from '@queue/tasks/threadGenerateTitleTask';
import { useRecordedJobCommits } from '@test/jobCommits';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

useTestDb();
const commitSettingsOf = useRecordedJobCommits();

const titling = () => ({ userId: randomUUID(), threadId: randomUUID(), forced: false });

describe('enqueueJob', () => {
  it('commits a standalone job without waiting for the flush', async () => {
    await enqueueThreadGenerateTitle(titling());

    expect(await commitSettingsOf({ operation: 'INSERT', task: 'threadGenerateTitle' })).toEqual([
      'off',
    ]);
  });

  it('leaves a job inside the caller\u2019s transaction as durable as that transaction', async () => {
    await inTransaction((trx) => enqueueThreadGenerateTitle(titling(), trx));

    expect(await commitSettingsOf({ operation: 'INSERT', task: 'threadGenerateTitle' })).toEqual([
      'on',
    ]);
  });
});

import { enqueueJob } from '@queries/queue/enqueueJob';
import { findJobByKey } from '@queries/queue/findJobByKey';
import { listDeadJobs } from '@queries/queue/listDeadJobs';
import { requeueDeadJobs } from '@queue/deadJobs';
import { registeredTask } from '@queue/worker';
import { addDeadJob, drainQueue } from '@test/queue';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

useTestDb();

declare global {
  namespace GraphileWorker {
    interface Tasks {
      probeRevive: { subject: string };
    }
  }
}

function probeTask() {
  const runs: string[] = [];
  const tasks = {
    probeRevive: registeredTask('probeRevive', {
      execute: async ({ subject }) => {
        runs.push(subject);
      },
    }),
  };
  return { runs, tasks };
}

describe('requeueDeadJobs', () => {
  it('makes dead jobs of either class due again with all their attempts', async () => {
    const probe = probeTask();
    await addDeadJob({
      task: 'probeRevive',
      key: 'fatal',
      payload: { subject: 'fatal' },
      errorClass: 'fatal',
    });
    await addDeadJob({
      task: 'probeRevive',
      key: 'cold',
      payload: { subject: 'cold' },
      errorClass: 'recoverable',
    });

    const { requeued, superseded } = await requeueDeadJobs();

    expect(requeued.map((job) => job.key).sort()).toEqual([
      'probeRevive:cold',
      'probeRevive:fatal',
    ]);
    expect(superseded).toEqual([]);
    expect(await findJobByKey({ task: 'probeRevive', key: 'fatal' })).toMatchObject({
      state: 'queued',
    });
    await drainQueue(probe.tasks);
    expect(probe.runs.sort()).toEqual(['cold', 'fatal']);
    expect(await listDeadJobs()).toEqual([]);
  });

  it('leaves a dead job alone once a newer job for its key owns the work', async () => {
    const probe = probeTask();
    await addDeadJob({
      task: 'probeRevive',
      key: 'a',
      payload: { subject: 'old' },
      errorClass: 'fatal',
    });
    await enqueueJob({
      task: 'probeRevive',
      payload: { subject: 'new' },
      key: 'a',
      maxAttempts: 3,
    });

    const { requeued, superseded } = await requeueDeadJobs();

    expect(requeued).toEqual([]);
    expect(superseded).toMatchObject([{ task: 'probeRevive', key: null }]);
    await drainQueue(probe.tasks);
    expect(probe.runs).toEqual(['new']);
  });
});

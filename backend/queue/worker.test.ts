import { enqueueJob } from '@queries/queue/enqueueJob';
import { findJobByKeyOrNull } from '@queries/queue/findJobByKey';
import { listDeadJobs } from '@queries/queue/listDeadJobs';
import { inTransaction } from '@queries/transaction/inTransaction';
import { TaskFailure, classifyTaskError } from '@queue/errors';
import { MEMORY_CAPTURE_SEGMENT } from '@queue/tasks/memoryCaptureSegmentTask';
import { type QueueTask, queueTasks, registeredTask } from '@queue/worker';
import { memoryOff, memoryOn } from '@test/memory';
import { drainQueue, makeWaitingJobsDue } from '@test/queue';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

useTestDb();

declare global {
  namespace GraphileWorker {
    interface Tasks {
      probeRun: { subject: string };
    }
  }
}

/** A task that records each run and fails however the test asks it to. */
function probeTask(failure: () => Error | null) {
  const runs: string[] = [];
  const givenUp: string[] = [];
  const task: QueueTask<'probeRun'> = {
    execute: async ({ subject }) => {
      runs.push(subject);
      const error = failure();
      if (error) throw error;
    },
    onGivenUp: async ({ subject }, errorClass) => {
      givenUp.push(`${subject}:${errorClass}`);
    },
  };
  return { runs, givenUp, tasks: { probeRun: registeredTask('probeRun', task) } };
}

function enqueueProbe(key: string, payload: { subject: string } = { subject: key }) {
  return enqueueJob({ task: 'probeRun', payload, key, maxAttempts: 3 });
}

describe('enqueueJob', () => {
  it('merges a second job for the same key into the one still waiting', async () => {
    const probe = probeTask(() => null);
    await enqueueProbe('a');
    await enqueueProbe('a');
    await enqueueProbe('b');

    await drainQueue(probe.tasks);

    expect(probe.runs.sort()).toEqual(['a', 'b']);
    expect(await findJobByKeyOrNull({ task: 'probeRun', key: 'a' })).toBeNull();
  });

  it('commits with the transaction it is given, and not without it', async () => {
    await inTransaction(async (trx) => {
      await enqueueJob(
        { task: 'probeRun', payload: { subject: 'kept' }, key: 'kept', maxAttempts: 3 },
        trx,
      );
    });
    await expect(
      inTransaction(async (trx) => {
        await enqueueJob(
          { task: 'probeRun', payload: { subject: 'dropped' }, key: 'dropped', maxAttempts: 3 },
          trx,
        );
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');

    expect(await findJobByKeyOrNull({ task: 'probeRun', key: 'kept' })).toMatchObject({
      state: 'queued',
      errorClass: null,
    });
    expect(await findJobByKeyOrNull({ task: 'probeRun', key: 'dropped' })).toBeNull();
  });
});

describe('the worker', () => {
  it('retries a recoverable failure until its attempts run out, then leaves it dead', async () => {
    const probe = probeTask(() => new TaskFailure('embed_failed', 'provider hiccup'));
    await enqueueProbe('flaky');

    await drainQueue(probe.tasks);
    expect(await findJobByKeyOrNull({ task: 'probeRun', key: 'flaky' })).toMatchObject({
      state: 'queued',
      errorClass: 'recoverable',
      lastError: '[recoverable] embed_failed: provider hiccup',
    });
    expect(probe.givenUp).toEqual([]);

    for (let attempt = 2; attempt <= 3; attempt += 1) {
      await makeWaitingJobsDue();
      await drainQueue(probe.tasks);
    }

    expect(probe.runs).toEqual(['flaky', 'flaky', 'flaky']);
    expect(probe.givenUp).toEqual(['flaky:recoverable']);
    expect(await findJobByKeyOrNull({ task: 'probeRun', key: 'flaky' })).toMatchObject({
      state: 'dead',
      errorClass: 'recoverable',
    });
    expect(await listDeadJobs()).toMatchObject([
      { task: 'probeRun', key: 'probeRun:flaky', attempts: 3, errorClass: 'recoverable' },
    ]);
  });

  it('leaves a fatal failure dead on its first attempt', async () => {
    const probe = probeTask(() => new TaskFailure('provider_not_configured'));
    await enqueueProbe('broken');

    await drainQueue(probe.tasks);
    await makeWaitingJobsDue();
    await drainQueue(probe.tasks);

    expect(probe.runs).toEqual(['broken']);
    expect(probe.givenUp).toEqual(['broken:fatal']);
    expect(await findJobByKeyOrNull({ task: 'probeRun', key: 'broken' })).toMatchObject({
      state: 'dead',
      errorClass: 'fatal',
      lastError: '[fatal] provider_not_configured',
    });
  });

  it('fails an attempt that runs past the time limit as recoverable, and frees its job', async () => {
    const hung: QueueTask<'probeRun'> = { execute: () => new Promise<void>(() => {}) };
    await enqueueProbe('hung');

    await drainQueue({ probeRun: registeredTask('probeRun', hung, { timeLimitMs: 50 }) });

    expect(await findJobByKeyOrNull({ task: 'probeRun', key: 'hung' })).toMatchObject({
      state: 'queued',
      errorClass: 'recoverable',
      lastError: '[recoverable] task_timed_out: ran past 50 ms',
    });
  });

  it('queues a fresh job behind a dead one when the same key is asked for again', async () => {
    let failing = true;
    const probe = probeTask(() => (failing ? new TaskFailure('provider_not_configured') : null));
    await enqueueProbe('revived');
    await drainQueue(probe.tasks);
    failing = false;

    await enqueueProbe('revived');
    expect(await findJobByKeyOrNull({ task: 'probeRun', key: 'revived' })).toMatchObject({
      state: 'queued',
      errorClass: null,
    });
    await drainQueue(probe.tasks);

    expect(probe.runs).toEqual(['revived', 'revived']);
    expect(await findJobByKeyOrNull({ task: 'probeRun', key: 'revived' })).toBeNull();
  });
});

describe('classifyTaskError', () => {
  it('treats missing configuration, rejected credentials and bad input as fatal', () => {
    expect(classifyTaskError(new TaskFailure('provider_not_configured'))).toBe('fatal');
    expect(classifyTaskError(new TaskFailure('provider_not_configured'))).toBe('fatal');
    expect(classifyTaskError(Object.assign(new Error('unauthorized'), { statusCode: 401 }))).toBe(
      'fatal',
    );
    expect(classifyTaskError(Object.assign(new Error('bad request'), { statusCode: 400 }))).toBe(
      'fatal',
    );
  });

  it('treats rate limits, busy models, timeouts and the unknown as recoverable', () => {
    expect(classifyTaskError(new TaskFailure('embed_failed'))).toBe('recoverable');
    expect(classifyTaskError(Object.assign(new Error('slow down'), { statusCode: 429 }))).toBe(
      'recoverable',
    );
    expect(classifyTaskError(Object.assign(new Error('loading'), { statusCode: 503 }))).toBe(
      'recoverable',
    );
    expect(classifyTaskError(new Error('fetch failed'))).toBe('recoverable');
    expect(classifyTaskError('a thrown string')).toBe('recoverable');
  });
});

describe('queueTasks', () => {
  it('works capture jobs only in a deployment with Memory', () => {
    expect(Object.keys(queueTasks(memoryOff))).not.toContain(MEMORY_CAPTURE_SEGMENT);
    expect(Object.keys(queueTasks(memoryOn))).toContain(MEMORY_CAPTURE_SEGMENT);
  });
});

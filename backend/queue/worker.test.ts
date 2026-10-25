import { enqueueJob } from '@queries/queue/enqueueJob';
import { findJobByKey } from '@queries/queue/findJobByKey';
import { listDeadJobs } from '@queries/queue/listDeadJobs';
import { inTransaction } from '@queries/transaction/inTransaction';
import { workerSlots } from '@queue/busySlots';
import { TaskFailure, classifyTaskError } from '@queue/errors';
import { MEMORY_CAPTURE_SEGMENT } from '@queue/tasks/memoryCaptureSegmentTask';
import { queueTasks, registeredTask } from '@queue/worker';
import { useAppRecordCapture } from '@test/appRecords';
import { memoryOff, memoryOn } from '@test/memory';
import { drainQueue, makeWaitingJobsDue } from '@test/queue';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

useTestDb();
const capture = useAppRecordCapture();

declare global {
  namespace GraphileWorker {
    interface Tasks {
      probeRun: { subject: string };
    }
  }
}

type ProbeTask = Parameters<typeof registeredTask<'probeRun'>>[1];

/** A task that records each run and fails however the test asks it to. */
function probeTask(failure: () => Error | null) {
  const runs: string[] = [];
  const givenUp: string[] = [];
  const task: ProbeTask = {
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
    expect(await findJobByKey({ task: 'probeRun', key: 'a' })).toBeNull();
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

    expect(await findJobByKey({ task: 'probeRun', key: 'kept' })).toMatchObject({
      state: 'queued',
      errorClass: null,
    });
    expect(await findJobByKey({ task: 'probeRun', key: 'dropped' })).toBeNull();
  });
});

describe('the job record', () => {
  it('says when an attempt was due, started and finished, and that it succeeded', async () => {
    const probe = probeTask(() => null);
    await enqueueProbe('quiet', { subject: 'private payload' });
    const before = Date.now();

    await drainQueue(probe.tasks);

    const [line, ...others] = capture.written('job');
    expect(others).toEqual([]);
    expect(line).toMatchObject({
      task: 'probeRun',
      attempt: 1,
      outcome: 'succeeded',
      errorClass: null,
      errorCode: null,
    });
    expect(line?.jobId).toEqual(expect.any(String));
    const queued = Date.parse(line?.queuedAt ?? '');
    const started = Date.parse(line?.startedAt ?? '');
    const finished = Date.parse(line?.finishedAt ?? '');
    expect(queued).toBeLessThanOrEqual(started);
    expect(started).toBeLessThanOrEqual(finished);
    expect(finished).toBeLessThanOrEqual(Date.now());
    expect(started).toBeGreaterThanOrEqual(before - 5_000);
    expect(line?.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(line)).not.toContain('private payload');
  });

  it('writes a line for every attempt of a job that keeps failing, with the failure’s class and code', async () => {
    const probe = probeTask(() => new TaskFailure('embed_failed', 'provider hiccup'));
    await enqueueProbe('flaky');

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await makeWaitingJobsDue();
      await drainQueue(probe.tasks);
    }

    expect(capture.written('job')).toMatchObject([
      { attempt: 1, outcome: 'failed', errorClass: 'recoverable', errorCode: 'embed_failed' },
      { attempt: 2, outcome: 'failed', errorClass: 'recoverable', errorCode: 'embed_failed' },
      { attempt: 3, outcome: 'failed', errorClass: 'recoverable', errorCode: 'embed_failed' },
    ]);
  });

  it('writes a fatal failure as fatal', async () => {
    const probe = probeTask(() => new TaskFailure('provider_not_configured'));
    await enqueueProbe('broken');

    await drainQueue(probe.tasks);

    expect(capture.written('job')).toMatchObject([
      { outcome: 'failed', errorClass: 'fatal', errorCode: 'provider_not_configured' },
    ]);
  });

  it('writes an attempt that ran past its time limit as timed out', async () => {
    const hung: ProbeTask = { execute: () => new Promise<void>(() => {}) };
    await enqueueProbe('hung');

    await drainQueue({ probeRun: registeredTask('probeRun', hung, { timeLimitMs: 50 }) });

    expect(capture.written('job')).toMatchObject([
      { outcome: 'timed-out', errorClass: 'recoverable', errorCode: 'task_timed_out' },
    ]);
  });
});

describe('the worker', () => {
  it('retries a recoverable failure until its attempts run out, then leaves it dead', async () => {
    const probe = probeTask(() => new TaskFailure('embed_failed', 'provider hiccup'));
    await enqueueProbe('flaky');

    await drainQueue(probe.tasks);
    expect(await findJobByKey({ task: 'probeRun', key: 'flaky' })).toMatchObject({
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
    expect(await findJobByKey({ task: 'probeRun', key: 'flaky' })).toMatchObject({
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
    expect(await findJobByKey({ task: 'probeRun', key: 'broken' })).toMatchObject({
      state: 'dead',
      errorClass: 'fatal',
      lastError: '[fatal] provider_not_configured',
    });
  });

  it('fails an attempt that runs past the time limit as recoverable, and frees its job', async () => {
    const hung: ProbeTask = { execute: () => new Promise<void>(() => {}) };
    await enqueueProbe('hung');

    await drainQueue({ probeRun: registeredTask('probeRun', hung, { timeLimitMs: 50 }) });

    expect(await findJobByKey({ task: 'probeRun', key: 'hung' })).toMatchObject({
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
    expect(await findJobByKey({ task: 'probeRun', key: 'revived' })).toMatchObject({
      state: 'queued',
      errorClass: null,
    });
    await drainQueue(probe.tasks);

    expect(probe.runs).toEqual(['revived', 'revived']);
    expect(await findJobByKey({ task: 'probeRun', key: 'revived' })).toBeNull();
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
    expect(
      Object.keys(queueTasks({ memory: memoryOff, threadAnalysisMode: 'heuristic' })),
    ).not.toContain(MEMORY_CAPTURE_SEGMENT);
    expect(
      Object.keys(queueTasks({ memory: memoryOn, threadAnalysisMode: 'heuristic' })),
    ).toContain(MEMORY_CAPTURE_SEGMENT);
  });
});

describe('the worker’s slots', () => {
  it('count an attempt as busy while its task runs, and free it when it ends', async () => {
    const busyWhileRunning: number[] = [];
    const tasks = {
      probeRun: registeredTask('probeRun', {
        execute: async () => {
          busyWhileRunning.push(workerSlots().busy);
        },
      }),
    };
    await enqueueProbe('counted');

    await drainQueue(tasks);

    expect(busyWhileRunning).toEqual([1]);
    expect(workerSlots().busy).toBe(0);
  });
});

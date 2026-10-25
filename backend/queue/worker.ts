import { EventEmitter } from 'node:events';
import type { ThreadAnalysisMode } from '@ari/lib/api/schemas/threads/analysis';
import type { JobErrorClass } from '@db/types';
import { jobErrorClassOrNull } from '@queries/queue/jobError';
import {
  type JobHelpers,
  Logger,
  type Task,
  type TaskList,
  type WorkerEvents,
  type WorkerUtils,
} from 'graphile-worker';
import { startJobLog } from '../src/appRecords/jobLog';
import { logger } from '../src/logger';
import type { MemoryFeature } from '../src/types/memory';
import { runningInSlot } from './busySlots';
import { TaskFailure, classifiedTaskError, classifyTaskError } from './errors';
import { whenArrivalJudged, whenJudgmentAbandoned } from './flows/driftGate';
import { whenSegmentCaptureAbandoned, whenSegmentCaptured } from './flows/memoryCapture';
import { whenThreadTitled } from './flows/threadTitling';
import { foldTurn } from './tasks/driftGateFoldTurnTask';
import { judgeArrival } from './tasks/driftGateJudgeArrivalTask';
import { captureMemorySegment } from './tasks/memoryCaptureSegmentTask';
import { titleThread } from './tasks/threadGenerateTitleTask';

/** The identifier of a task the worker knows, and so the payload its jobs carry. */
type TaskName = keyof GraphileWorker.Tasks;

/** A job's payload, as the task's own enqueue side wrote it. */
type TaskPayload<Name extends TaskName> = GraphileWorker.Tasks[Name];

/** One kind of background work, as the worker runs it. */
interface QueueTask<Name extends TaskName> {
  execute(payload: TaskPayload<Name>): Promise<void>;
  /**
   * Runs once a job will not run again on its own: it failed fatally, or
   * its last attempt failed.
   */
  onGivenUp?(payload: TaskPayload<Name>, errorClass: JobErrorClass): Promise<void>;
}

async function reportGivenUp<Name extends TaskName>(
  name: Name,
  task: QueueTask<Name>,
  payload: TaskPayload<Name>,
  errorClass: JobErrorClass,
): Promise<void> {
  try {
    await task.onGivenUp?.(payload, errorClass);
  } catch (error) {
    logger.error({ err: error, task: name }, 'queue task give-up hook failed');
  }
}

const TIMED_OUT_CODE = 'task_timed_out';

/**
 * How long one attempt of any task may run. An attempt past it fails as a
 * recoverable timeout, which frees its job for the next attempt.
 */
export const TASK_TIME_LIMIT_SECONDS = 120;

/**
 * Settles as `work` does, or fails with a recoverable timeout once
 * `limitMs` has passed. Work past its deadline is not cancelled; it runs
 * on unobserved, which is safe because every task is idempotent.
 */
async function withinTimeLimit(work: Promise<void>, limitMs: number, onTimeout: () => void) {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new TaskFailure(TIMED_OUT_CODE, `ran past ${limitMs} ms`));
    }, limitMs);
  });
  // Once the deadline wins, nobody awaits the work; a late failure of it
  // must not surface as an unhandled rejection.
  work.catch(() => {});
  try {
    await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** One attempt at a job: runs the task within its time limit and records how the attempt ended. */
async function runAttempt<Name extends TaskName>(
  name: Name,
  task: QueueTask<Name>,
  raw: unknown,
  { job }: Pick<JobHelpers, 'job'>,
  timeLimitMs: number,
): Promise<void> {
  // The engine hands back JSON the enqueue side wrote; shape changes ride
  // a renamed task, not this cast.
  const payload = raw as TaskPayload<Name>;
  const logJobEnded = startJobLog(name, job);
  try {
    await withinTimeLimit(task.execute(payload), timeLimitMs, () => {
      logger.warn(
        {
          task: name,
          jobId: job.id,
          attempt: job.attempts,
          maxAttempts: job.max_attempts,
          timeLimitMs,
        },
        'queue task ran past its time limit',
      );
    });
    logJobEnded({ outcome: 'succeeded', errorClass: null, errorCode: null });
  } catch (error) {
    const errorClass = classifyTaskError(error);
    const errorCode = error instanceof TaskFailure ? error.code : null;
    logJobEnded({
      outcome: errorCode === TIMED_OUT_CODE ? 'timed-out' : 'failed',
      errorClass,
      errorCode,
    });
    const lastAttempt = job.attempts >= job.max_attempts;
    if (errorClass === 'fatal' || lastAttempt) {
      await reportGivenUp(name, task, payload, errorClass);
    }
    throw classifiedTaskError(error);
  }
}

/**
 * Wraps a task for the worker, ending any attempt that runs past the time
 * limit and recording every failure with its class, so readers of the
 * queue can tell a retryable job from one waiting for the operator. An
 * attempt takes one of the worker's slots while it runs.
 */
export function registeredTask<Name extends TaskName>(
  name: Name,
  task: QueueTask<Name>,
  { timeLimitMs = TASK_TIME_LIMIT_SECONDS * 1000 }: { timeLimitMs?: number } = {},
): Task<Name> {
  return (raw, helpers) => runningInSlot(() => runAttempt(name, task, raw, helpers, timeLimitMs));
}

/** The deployment decisions that choose which tasks run and how. */
type QueueFeatures = { memory: MemoryFeature; threadAnalysisMode: ThreadAnalysisMode };

/** The names of the tasks this deployment runs; jobs of any other task stay queued here untouched. */
export function runnableTaskNames(features: QueueFeatures) {
  return Object.keys(queueTasks(features));
}

/**
 * Every task this deployment runs. Each task computes its outcome; its
 * flow translates that outcome into announcements and follow-up work.
 * Memory's capture runs only while Memory is on; its jobs wait otherwise.
 */
export function queueTasks({ memory, threadAnalysisMode }: QueueFeatures): TaskList {
  return {
    driftGateJudgeArrival: registeredTask('driftGateJudgeArrival', {
      execute: async (arrival) =>
        whenArrivalJudged({
          judgment: await judgeArrival({ arrival, threadAnalysisMode }),
          memory,
        }),
      onGivenUp: async (params) => whenJudgmentAbandoned(params),
    }),
    driftGateFoldTurn: registeredTask('driftGateFoldTurn', {
      // The fold has no sequel: its checkpoint is the outcome, and the next
      // judgment is the only thing that reads it.
      execute: (turn) => foldTurn({ turn, threadAnalysisMode }),
    }),
    threadGenerateTitle: registeredTask('threadGenerateTitle', {
      execute: async (params) => whenThreadTitled(await titleThread(params)),
    }),
    ...(memory.kind === 'on' && {
      memoryCaptureSegment: registeredTask('memoryCaptureSegment', {
        execute: async (segment) => whenSegmentCaptured(await captureMemorySegment(segment)),
        onGivenUp: async (segment) => whenSegmentCaptureAbandoned(segment),
      }),
    }),
  };
}

/** How often, and how many times, a fatal job is checked for release. */
const RELEASE_POLL_MS = 50;
const RELEASE_POLL_TRIES = 40;

/**
 * Marks a fatally failed job dead as soon as the worker has let go of it,
 * so it spends no further attempts. The job stays locked for a moment
 * after its task throws, and only an unlocked job can be marked.
 */
async function markDeadOnceReleased(
  utils: Pick<WorkerUtils, 'permanentlyFailJobs'>,
  jobId: string,
  reason: string,
) {
  for (let tries = 0; tries < RELEASE_POLL_TRIES; tries += 1) {
    const marked = await utils.permanentlyFailJobs([jobId], reason);
    if (marked.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, RELEASE_POLL_MS));
  }
  logger.warn({ jobId }, 'fatal queue job was never released; it keeps its remaining attempts');
}

/** The engine's log lines, routed into the app log; routine chatter drops to debug. */
const queueLogger = new Logger((scope) => (level, message) => {
  const fields = { queue: scope };
  if (level === 'error') logger.error(fields, message);
  else if (level === 'warning') logger.warn(fields, message);
  else logger.debug(fields, message);
});

export function queueRuntime(taskList: TaskList, utils: Pick<WorkerUtils, 'permanentlyFailJobs'>) {
  // The engine types its emitter with a typed-event overlay that a plain
  // EventEmitter satisfies at runtime but not structurally.
  const events = new EventEmitter() as WorkerEvents;
  const marking = new Set<Promise<void>>();

  events.on('job:error', ({ job, error }) => {
    const reason = error instanceof Error ? error.message : String(error);
    if (jobErrorClassOrNull(reason) !== 'fatal' || job.attempts >= job.max_attempts) return;
    const marked = markDeadOnceReleased(utils, job.id, reason).catch((markError: unknown) => {
      logger.error({ err: markError, jobId: job.id }, 'could not mark a fatal queue job dead');
    });
    marking.add(marked);
    void marked.finally(() => marking.delete(marked));
  });

  return {
    taskList,
    events,
    logger: queueLogger,
    settled: async () => {
      await Promise.all([...marking]);
    },
  };
}

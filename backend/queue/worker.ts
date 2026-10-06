import { EventEmitter } from 'node:events';
import { type JobErrorClass, jobErrorClassOrNull } from '@queries/queue/jobError';
import {
  Logger,
  type Task,
  type TaskList,
  type WorkerEvents,
  type WorkerUtils,
} from 'graphile-worker';
import { logger } from '../src/logger';
import { classifiedTaskError, classifyTaskError } from './errors';
import { whenArrivalJudged, whenJudgmentAbandoned } from './flows/driftGate';
import { judgeArrival } from './tasks/driftGateJudgeArrivalTask';
import { executeMemoryCaptureSegment } from './tasks/memoryCaptureSegmentTask';

/** The identifier of a task the worker knows, and so the payload its jobs carry. */
export type TaskName = keyof GraphileWorker.Tasks;

/** A job's payload, as the task's own enqueue side wrote it. */
export type TaskPayload<Name extends TaskName> = GraphileWorker.Tasks[Name];

/** One kind of background work, as the worker runs it. */
export interface QueueTask<Name extends TaskName> {
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

/**
 * Wraps a task for the worker, recording every failure with its class so
 * readers of the queue can tell a retryable job from one waiting for the
 * operator.
 */
export function registeredTask<Name extends TaskName>(
  name: Name,
  task: QueueTask<Name>,
): Task<Name> {
  return async (raw, helpers) => {
    // The engine hands back JSON the enqueue side wrote; shape changes ride
    // a renamed task, not this cast.
    const payload = raw as TaskPayload<Name>;
    try {
      await task.execute(payload);
    } catch (error) {
      const errorClass = classifyTaskError(error);
      const lastAttempt = helpers.job.attempts >= helpers.job.max_attempts;
      if (errorClass === 'fatal' || lastAttempt) {
        await reportGivenUp(name, task, payload, errorClass);
      }
      throw classifiedTaskError(error);
    }
  };
}

/**
 * Every task this deployment runs. Each task computes its outcome; its
 * flow translates that outcome into announcements and follow-up work.
 */
export function queueTasks(): TaskList {
  return {
    driftGateJudgeArrival: registeredTask('driftGateJudgeArrival', {
      execute: async (params) =>
        whenArrivalJudged({ params, judgment: await judgeArrival(params) }),
      onGivenUp: async (params) => whenJudgmentAbandoned(params),
    }),
    memoryCaptureSegment: registeredTask('memoryCaptureSegment', {
      execute: executeMemoryCaptureSegment,
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
): Promise<void> {
  for (let tries = 0; tries < RELEASE_POLL_TRIES; tries += 1) {
    const marked = await utils.permanentlyFailJobs([jobId], reason);
    if (marked.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, RELEASE_POLL_MS));
  }
  logger.warn({ jobId }, 'fatal queue job was never released; it keeps its remaining attempts');
}

/** What the worker is started with, for both the long-running and the one-shot runner. */
export interface QueueRuntime {
  taskList: TaskList;
  events: WorkerEvents;
  logger: Logger;
  /** Resolves once every fatal failure seen so far is marked dead. */
  settled(): Promise<void>;
}

/** The engine's log lines, routed into the app log; routine chatter drops to debug. */
const queueLogger = new Logger((scope) => (level, message) => {
  const fields = { queue: scope };
  if (level === 'error') logger.error(fields, message);
  else if (level === 'warning') logger.warn(fields, message);
  else logger.debug(fields, message);
});

export function queueRuntime(
  taskList: TaskList,
  utils: Pick<WorkerUtils, 'permanentlyFailJobs'>,
): QueueRuntime {
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

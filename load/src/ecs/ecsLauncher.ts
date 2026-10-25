import { stopOf } from '../archive/index.ts';
import { STOPPED_FOR_RUN_END } from '../records/index.ts';
import { TaskMayStillRun } from '../run/index.ts';
import type { TaskInfo } from '../types/archive.ts';
import type { GeneratorEnd, GeneratorLauncher, GeneratorStart } from '../types/run.ts';
import type { DescribedTask, EcsPort, Placement } from './ecsPort.ts';
import { messageOf } from './messageOf.ts';
import { taskWatch } from './taskWatch.ts';

/** How long a task may take to be running once it has been asked for, before it is stopped as stuck. */
const LAUNCH_DEADLINE_MS = 5 * 60_000;

const OUTLASTED_THE_RUN = 'The generator outlasted the run and was stopped';
const STUCK_LAUNCHING = 'The generator was not running in time and was stopped';
const END_UNKNOWN = 'ECS could not say how the generator ended, so it was stopped';

/** What the generators do: bring users up and hold them, or create the accounts. */
export type GeneratorMode = 'load' | 'seed';

type EcsLauncherInput = {
  ecs: EcsPort;
  runId: string;
  mode: GeneratorMode;
  /** Where generators are asked for first. On Spot, a launch that finds no capacity is made again On-Demand. */
  placement: Placement;
  /** Keeps a task as ECS described it when it stopped, before ECS forgets it. */
  keepStoppedTask: (task: TaskInfo) => Promise<void>;
  /** Says something went wrong that does not end the run. */
  warn: (line: string) => void;
  pollEveryMs: number;
  sleep: (milliseconds: number) => Promise<void>;
  /** How long a task may take to be running once it has been asked for, before it is stopped as stuck. */
  launchDeadlineMs?: number;
};

/**
 * Starts each generator as a task in ECS and watches all the tasks
 * together. A generator is launched once its task is running, so that the
 * plan counts from when the generator can begin it, and not from when the
 * task was asked for. A task that is not running by its deadline is stopped,
 * and its launch fails. A generator ends when its task stops. It was stopped
 * from outside when ECS says so, as Spot does when it takes capacity back,
 * and failed when its container exited with an error. A task that ECS can
 * no longer be asked about is stopped, so that the slice it ran is not
 * loaded twice. Each stopped task stays readable to the archive after ECS
 * no longer describes it.
 */
export function ecsLauncher(input: EcsLauncherInput): GeneratorLauncher {
  const watch = taskWatch(input);
  // One launch at a time, so that a stage's generators do not all ask ECS at once.
  let launching: Promise<unknown> = Promise.resolve();

  async function startTask(start: GeneratorStart): Promise<{ arn: string; spot: boolean }> {
    const environment = environmentOf(input.runId, input.mode, start);
    const placements: Placement[] =
      input.placement === 'spot' ? ['spot', 'on-demand'] : ['on-demand'];
    let lastReason = '';
    for (const placement of placements) {
      const outcome = await input.ecs.startTask({ placement, environment });
      if (outcome.started) return { arn: outcome.taskArn, spot: placement === 'spot' };
      lastReason = outcome.reason;
      // Only a lack of capacity is worth asking again elsewhere.
      if (!outcome.noCapacity) break;
    }
    throw new Error(lastReason);
  }

  const keepTask = (info: TaskInfo, arn: string): Promise<void> =>
    input.keepStoppedTask(info).catch((error: unknown) => {
      input.warn(`Keeping ${taskIdOf(arn)} failed: ${messageOf(error)}`);
    });

  return {
    async launch(start, signal) {
      signal.throwIfAborted();
      const started = launching.then(() => {
        signal.throwIfAborted();
        return startTask(start);
      });
      launching = started.catch(() => undefined);
      const { arn, spot } = await started;
      const watched = watch.watch(arn);
      let timedOut = false;
      let over = false;
      /** Whether ECS took the request; a failure is said, and the generator may still run. */
      const stopTask = (reason: string): Promise<boolean> =>
        input.ecs.stopTask(arn, reason).then(
          () => true,
          (error: unknown) => {
            input.warn(`Stopping ${taskIdOf(arn)} failed: ${messageOf(error)}`);
            return false;
          },
        );
      const keepWhenStopped = (): void => {
        void watched.stopped.then((task) => (task === null ? undefined : keepTask(task.info, arn)));
      };
      const launchDeadlineMs = input.launchDeadlineMs ?? LAUNCH_DEADLINE_MS;
      const up = await launchOutcomeOf(watched.running, { deadlineMs: launchDeadlineMs, signal });
      if (up !== 'running') {
        const stopped = await stopTask(up === 'aborted' ? STOPPED_FOR_RUN_END : STUCK_LAUNCHING);
        keepWhenStopped();
        if (up === 'aborted') throw signal.reason;
        const message = `Task ${taskIdOf(arn)} was not running ${Math.round(launchDeadlineMs / 1_000)} s after it was asked for`;
        if (stopped) throw new Error(`${message}, so it was stopped`);
        throw new TaskMayStillRun(`${message}, and it could not be stopped`);
      }
      const timer = setTimeout(() => {
        timedOut = true;
        void stopTask(OUTLASTED_THE_RUN);
      }, start.timeoutMs);
      const ended = watched.stopped.then(async (task) => {
        over = true;
        clearTimeout(timer);
        if (task === null) return endOf(null, timedOut, await stopTask(END_UNKNOWN));
        await keepTask(task.info, arn);
        return endOf(task, timedOut, true);
      });
      return {
        task: taskIdOf(arn),
        spot,
        ended,
        async stop() {
          if (!over) await stopTask(STOPPED_FOR_RUN_END);
          await ended;
        },
      };
    },
  };
}

/** What a generator is started with beyond its task definition: its run, its slice and its plan. */
function environmentOf(
  runId: string,
  mode: GeneratorMode,
  start: GeneratorStart,
): Record<string, string> {
  return {
    RUN_ID: runId,
    MODE: mode,
    GENERATOR: String(start.generator),
    ATTEMPT: String(start.attempt),
    ...(start.endsAt === null ? {} : { ENDS_AT: new Date(start.endsAt).toISOString() }),
    FIRST_USER: String(start.firstUser),
    USER_COUNT: String(start.userCount),
    RAMP_SECONDS: String(start.rampSeconds),
    HOLD_SECONDS: String(start.holdSeconds),
    THINK_SECONDS: String(start.thinkSeconds),
  };
}

/**
 * How a generator ended, from the task that ran it. The task is null when
 * ECS can no longer be asked about it. `stopped` says whether the load
 * command managed to stop that task.
 */
function endOf(task: DescribedTask | null, timedOut: boolean, stopped: boolean): GeneratorEnd {
  if (timedOut)
    return { how: 'stopped', reason: 'timed-out', detail: OUTLASTED_THE_RUN, report: null };
  if (task === null) {
    return {
      how: 'stopped',
      reason: 'failed',
      detail: stopped
        ? 'ECS could not say how the generator’s task ended, so the task was stopped'
        : 'ECS could not say how the generator’s task ended, and the task could not be stopped',
      report: null,
      ...(stopped ? {} : { mayStillRun: true }),
    };
  }
  const { reason, detail } = stopOf(task.info);
  if (reason === 'finished') return { how: 'finished', report: null };
  return { how: 'stopped', reason, detail: detail ?? '', report: null };
}

/** The task's id, the last part of its ARN. */
export const taskIdOf = (arn: string) => arn.split('/').pop() ?? arn;

/** Resolves once the task is running, or has stopped without ever running; says when the deadline passes or `signal` aborts first. */
function launchOutcomeOf(
  running: Promise<void>,
  options: { deadlineMs: number; signal: AbortSignal },
): Promise<'running' | 'too-slow' | 'aborted'> {
  return new Promise((resolve) => {
    const { deadlineMs, signal } = options;
    const finish = (outcome: 'running' | 'too-slow' | 'aborted'): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish('aborted');
    const timer = setTimeout(() => finish('too-slow'), deadlineMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) return finish('aborted');
    void running.then(() => finish('running'));
  });
}

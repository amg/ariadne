import {
  type AwsEvent,
  type RunEvent,
  STOPPED_FOR_RUN_END,
  type StopReason,
} from '../../records/index.ts';
import type { TaskInfo } from '../../types/archive.ts';
import { compareText } from './order.ts';

/** The stop codes ECS gives a task that was stopped on purpose: by the capacity coming back, or by someone. */
const STOPPED_FROM_OUTSIDE = ['SpotInterruption', 'UserInitiated'];

/** What ECS said of why a task stopped, in one line; empty when it said nothing. */
const saidOf = (task: TaskInfo) =>
  [task.stopCode, task.stoppedReason].filter((part) => part !== null).join(': ');

/** Why a generator's task stopped. */
export function stopOf(task: TaskInfo): {
  reason: Extract<StopReason, 'finished' | 'interrupted' | 'failed'>;
  detail: string | null;
} {
  const said = saidOf(task);
  if (task.stopCode !== null && STOPPED_FROM_OUTSIDE.includes(task.stopCode)) {
    return { reason: 'interrupted', detail: said };
  }
  if (task.exitCode === 0) return { reason: 'finished', detail: null };
  const exit = task.exitCode === null ? 'it never exited' : `it exited with ${task.exitCode}`;
  return { reason: 'failed', detail: said === '' ? exit : `${said} (${exit})` };
}

/**
 * The generator a task ran, and which try at its slice it was; null for a
 * task that is not a generator's. A replacement carries its own ramp and
 * hold, since it holds only for the time the run had left.
 */
function generatorOfTaskOrNull(task: TaskInfo) {
  const { GENERATOR, ATTEMPT, FIRST_USER, USER_COUNT, RAMP_SECONDS, HOLD_SECONDS, ENDS_AT } =
    task.environment;
  if (GENERATOR === undefined) return null;
  return {
    generator: Number(GENERATOR),
    attempt: Number(ATTEMPT ?? 1),
    firstUser: Number(FIRST_USER ?? 0),
    userCount: Number(USER_COUNT ?? 0),
    plan:
      RAMP_SECONDS === undefined || HOLD_SECONDS === undefined
        ? null
        : {
            rampSeconds: Number(RAMP_SECONDS),
            holdSeconds: Number(HOLD_SECONDS),
            endsAt: instantOrNull(ENDS_AT),
          },
  };
}

/** The time in milliseconds a task's environment gave, or null when it gave none that is a time. */
const instantOrNull = (text: string | undefined) => {
  const instant = Date.parse(text ?? '');
  return Number.isNaN(instant) ? null : instant;
};

/** Whether a task was stopped from outside before it ever ran, so that it loaded none of its users. */
const neverRan = (task: TaskInfo) => task.startedAt === null && task.stopCode === 'UserInitiated';

/**
 * The generator tasks, each with who they ran, in the order of generator
 * and attempt. A task stopped before it ever ran is not one: its slice was
 * waiting for the next attempt all the while.
 */
export function generatorTasksOf(tasks: readonly TaskInfo[]) {
  return tasks
    .filter((task) => !neverRan(task))
    .flatMap((task) => {
      const generator = generatorOfTaskOrNull(task);
      return generator === null ? [] : [{ task, ...generator }];
    })
    .sort((a, b) => a.generator - b.generator || a.attempt - b.attempt);
}

/**
 * The events of a run on aws-prod: when it started and ended, and each
 * generator's launch and stop, as ECS tells them. A task that never
 * started counts from when it was created, and one still running has no
 * stop. A generator whose slice was run again is replaced by the next
 * attempt at it. A generator is planned by the ramp and hold it was started
 * with, and by `plan` when it was started with none.
 */
export function runEventsOf(input: {
  startedAt: string;
  endedAt: string;
  outcome: Extract<RunEvent, { kind: 'run-ended' }>['outcome'];
  /** The seconds a generator ramps its users up and holds them; both zero for a generator with no plan. */
  plan: { rampSeconds: number; holdSeconds: number };
  tasks: readonly TaskInfo[];
}): RunEvent[] {
  const generators = generatorTasksOf(input.tasks);
  const events = generators.flatMap(({ task, generator, attempt, firstUser, userCount, plan }) => {
    const { rampSeconds, holdSeconds } = plan ?? input.plan;
    const hasPlan = rampSeconds + holdSeconds > 0;
    const launchedAt = task.startedAt ?? task.createdAt ?? input.startedAt;
    const after = (seconds: number): number => Date.parse(launchedAt) + seconds * 1_000;
    const holdEndsAt = plan?.endsAt ?? after(rampSeconds + holdSeconds);
    const launched: RunEvent = {
      kind: 'generator-launched',
      at: launchedAt,
      generator,
      attempt,
      firstUser,
      userCount,
      task: task.taskId,
      spot: task.capacityProvider === 'FARGATE_SPOT',
      planned: hasPlan
        ? {
            rampEndsAt: new Date(Math.min(after(rampSeconds), holdEndsAt)).toISOString(),
            holdEndsAt: new Date(holdEndsAt).toISOString(),
          }
        : null,
    };
    if (task.stoppedAt === null) return [launched];
    const replacement = generators.find(
      (other) => other.generator === generator && other.attempt > attempt,
    );
    const stopped: RunEvent = {
      kind: 'generator-stopped',
      at: task.stoppedAt,
      generator,
      attempt,
      ...stopOf(task),
      toldToStopAt: task.stoppingAt,
      stoppedForRunEnd: task.stoppedReason?.startsWith(STOPPED_FOR_RUN_END) ?? false,
      replacedByAttempt: replacement?.attempt ?? null,
    };
    return [launched, stopped];
  });
  return [
    { kind: 'run-started', at: input.startedAt },
    ...events.sort((a, b) => compareText(a.at, b.at)),
    { kind: 'run-ended', at: input.endedAt, outcome: input.outcome },
  ];
}

/** Why each stopped task stopped, as events at the time it did, before ECS forgets. */
export function taskStopEventsOf(tasks: readonly TaskInfo[]) {
  return tasks.flatMap((task): AwsEvent[] =>
    task.stoppedAt === null
      ? []
      : [
          {
            at: task.stoppedAt,
            source: 'task-stop',
            resource: `${task.cluster}/${task.taskId}`,
            summary: saidOf(task),
            detail: {
              exitCode: task.exitCode,
              createdAt: task.createdAt,
              startedAt: task.startedAt,
              capacityProvider: task.capacityProvider,
            },
          },
        ],
  );
}

/**
 * How a run ended, from how its generators stopped: failed when any of them
 * failed, interrupted when any was stopped from outside, finished otherwise.
 */
export function outcomeOfGenerators(
  tasks: readonly TaskInfo[],
): Extract<RunEvent, { kind: 'run-ended' }>['outcome'] {
  const reasons = generatorTasksOf(tasks)
    .filter(({ task }) => task.stoppedAt !== null)
    .map(({ task }) => stopOf(task).reason);
  if (reasons.includes('failed')) return 'failed';
  return reasons.includes('interrupted') ? 'interrupted' : 'finished';
}

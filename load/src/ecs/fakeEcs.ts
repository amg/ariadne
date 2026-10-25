import type { TaskInfo } from '../types/archive.ts';
import type { DescribedTask, EcsPort, Placement, StartOutcome } from './ecsPort.ts';

/** One task the fake ECS started. */
type FakeTask = {
  arn: string;
  placement: Placement;
  environment: Readonly<Record<string, string>>;
  running: boolean;
  stopped: boolean;
  stopCode: string | null;
  stoppedReason: string | null;
  exitCode: number | null;
};

type FakeState = {
  noCapacityOn: Set<Placement>;
  refuseWith: string | null;
  /** Tasks ECS does not know, as when they stopped long ago. */
  forgotten: Set<string>;
  describeFails: Error | null;
  stopFails: Error | null;
  listFails: Error | null;
  /** Whether a task starts out waiting to run, as while its image is pulled. */
  startSlowly: boolean;
};

/**
 * An ECS with no capacity limits unless told, whose tasks run until the
 * test stops them in the way Spot, an operator or the container itself would.
 */
export function fakeEcs() {
  const tasks: FakeTask[] = [];
  const state: FakeState = {
    noCapacityOn: new Set<Placement>(),
    refuseWith: null,
    forgotten: new Set<string>(),
    describeFails: null,
    stopFails: null,
    listFails: null,
    startSlowly: false,
  };

  const port: EcsPort = {
    async startTask({ placement, environment }): Promise<StartOutcome> {
      if (state.refuseWith !== null) {
        return { started: false, reason: state.refuseWith, noCapacity: false };
      }
      if (state.noCapacityOn.has(placement)) {
        return { started: false, reason: 'Capacity is unavailable at this time', noCapacity: true };
      }
      const arn = `arn:aws:ecs:ap-southeast-2:1:task/load/task-${tasks.length + 1}`;
      tasks.push({
        arn,
        placement,
        environment,
        running: !state.startSlowly,
        stopped: false,
        stopCode: null,
        stoppedReason: null,
        exitCode: null,
      });
      return { started: true, taskArn: arn };
    },
    async describeTasks(arns) {
      if (state.describeFails !== null) throw state.describeFails;
      return new Map(
        arns.map((arn): [string, DescribedTask | null] => {
          const task = tasks.find((candidate) => candidate.arn === arn);
          if (task === undefined || state.forgotten.has(arn)) return [arn, null];
          return [
            arn,
            { running: task.running && !task.stopped, stopped: task.stopped, info: infoOf(task) },
          ];
        }),
      );
    },
    async stopTask(arn, reason) {
      if (state.stopFails !== null) throw state.stopFails;
      const task = tasks.find((candidate) => candidate.arn === arn);
      if (task === undefined) throw new Error(`no task ${arn}`);
      stop(task, { stopCode: 'UserInitiated', stoppedReason: reason, exitCode: 0 });
    },
    async runningTaskArns() {
      if (state.listFails !== null) throw state.listFails;
      return tasks.filter((task) => !task.stopped).map((task) => task.arn);
    },
  };

  const stop = (
    task: FakeTask,
    how: Pick<FakeTask, 'stopCode' | 'stoppedReason' | 'exitCode'>,
  ): void => {
    if (task.stopped) return;
    Object.assign(task, how, { stopped: true });
  };

  /** The task a generator's attempt ran in. */
  const taskOf = (generator: number, attempt = 1): FakeTask => {
    const found = tasks.find(
      (task) =>
        task.environment.GENERATOR === String(generator) &&
        task.environment.ATTEMPT === String(attempt),
    );
    if (found === undefined)
      throw new Error(`generator ${generator} attempt ${attempt} not started`);
    return found;
  };

  return {
    port,
    tasks,
    state,
    taskOf,
    markRunning: (task: FakeTask) => {
      task.running = true;
    },
    finish: (task: FakeTask) =>
      stop(task, {
        stopCode: 'EssentialContainerExited',
        stoppedReason: 'Essential container in task exited',
        exitCode: 0,
      }),
    fail: (task: FakeTask) =>
      stop(task, {
        stopCode: 'EssentialContainerExited',
        stoppedReason: 'Essential container in task exited',
        exitCode: 1,
      }),
    spotTakesBack: (task: FakeTask) =>
      stop(task, {
        stopCode: 'SpotInterruption',
        stoppedReason: 'Your Spot Task was interrupted.',
        exitCode: 0,
      }),
    stopByHand: (task: FakeTask) =>
      stop(task, { stopCode: 'UserInitiated', stoppedReason: 'Stopped by hand', exitCode: 143 }),
  };
}

function infoOf(task: FakeTask): TaskInfo {
  return {
    taskId: task.arn.split('/').pop() ?? task.arn,
    cluster: 'load',
    createdAt: '2026-10-15T00:00:00.000Z',
    startedAt: '2026-10-15T00:00:30.000Z',
    stoppingAt: task.stopped ? '2026-10-15T00:04:20.000Z' : null,
    stoppedAt: task.stopped ? '2026-10-15T00:05:00.000Z' : null,
    stopCode: task.stopCode,
    stoppedReason: task.stoppedReason,
    exitCode: task.exitCode,
    capacityProvider: task.placement === 'spot' ? 'FARGATE_SPOT' : 'FARGATE',
    environment: task.environment,
  };
}

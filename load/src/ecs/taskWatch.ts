import type { DescribedTask, EcsPort } from './ecsPort.ts';
import { messageOf } from './messageOf.ts';

/** How many times in a row ECS may fail to answer before the tasks waiting on it are given up on. */
const MAX_FAILED_POLLS = 12;

/** What watching one task gives. */
type WatchedTask = {
  /** Settles once the task is running, or has stopped without ever running. Never rejects. */
  running: Promise<void>;
  /** Settles with the task once it has stopped; null when ECS no longer knows it or cannot be asked. Never rejects. */
  stopped: Promise<DescribedTask | null>;
};

type Deferred<Value> = { promise: Promise<Value>; settle: (value: Value) => void };

function deferred<Value>(): Deferred<Value> {
  let settle: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * Watches generators' tasks together, asking ECS about all of them in one
 * request every `pollEveryMs`.
 */
export function taskWatch(input: {
  ecs: EcsPort;
  pollEveryMs: number;
  sleep: (milliseconds: number) => Promise<void>;
  warn: (line: string) => void;
}): { watch: (taskArn: string) => WatchedTask } {
  const waiting = new Map<
    string,
    { running: Deferred<void>; stopped: Deferred<DescribedTask | null> }
  >();
  let polling = false;

  function settleStopped(arn: string, task: DescribedTask | null): void {
    const entry = waiting.get(arn);
    waiting.delete(arn);
    entry?.running.settle();
    entry?.stopped.settle(task);
  }

  async function askAboutWaitingTasks(): Promise<void> {
    const described = await input.ecs.describeTasks([...waiting.keys()]);
    for (const [arn, task] of described) {
      if (task === null || task.stopped) settleStopped(arn, task);
      else if (task.running) waiting.get(arn)?.running.settle();
    }
  }

  async function pollWhileWaiting(): Promise<void> {
    polling = true;
    let failedPolls = 0;
    while (waiting.size > 0) {
      await input.sleep(input.pollEveryMs);
      try {
        await askAboutWaitingTasks();
        failedPolls = 0;
      } catch (error) {
        failedPolls += 1;
        if (failedPolls >= MAX_FAILED_POLLS) {
          input.warn(`ECS did not answer ${failedPolls} times: ${messageOf(error)}`);
          for (const arn of [...waiting.keys()]) settleStopped(arn, null);
        }
      }
    }
    polling = false;
  }

  return {
    watch(taskArn) {
      const entry = { running: deferred<void>(), stopped: deferred<DescribedTask | null>() };
      waiting.set(taskArn, entry);
      if (!polling) void pollWhileWaiting();
      return { running: entry.running.promise, stopped: entry.stopped.promise };
    },
  };
}

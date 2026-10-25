import { describe, expect, it } from 'vitest';
import { fakeEcs } from './fakeEcs.ts';
import { stopEveryGenerator } from './stopEveryGenerator.ts';

const stopping = (ecs: ReturnType<typeof fakeEcs>, sleep = async () => undefined) =>
  stopEveryGenerator({ ecs: ecs.port, reason: 'the command ended', pollEveryMs: 10_000, sleep });

const started = (ecs: ReturnType<typeof fakeEcs>) =>
  ecs.port.startTask({ placement: 'spot', environment: { GENERATOR: '0', ATTEMPT: '1' } });

describe('stopEveryGenerator', () => {
  it('stops every task still running, whoever started it, and gives the reason', async () => {
    const ecs = fakeEcs();
    await started(ecs);
    await started(ecs);

    await stopping(ecs);

    expect(ecs.tasks.map((task) => [task.stopped, task.stoppedReason])).toEqual([
      [true, 'the command ended'],
      [true, 'the command ended'],
    ]);
  });

  it('does nothing when no task is running', async () => {
    const ecs = fakeEcs();

    await expect(stopping(ecs)).resolves.toBeUndefined();
  });

  it('leaves a task that has already stopped as it is', async () => {
    const ecs = fakeEcs();
    await started(ecs);
    ecs.finish(ecs.taskOf(0));

    await stopping(ecs);

    expect(ecs.taskOf(0).stoppedReason).toBe('Essential container in task exited');
  });

  it('waits until ECS says the tasks have stopped', async () => {
    const ecs = fakeEcs();
    await started(ecs);
    const task = ecs.taskOf(0);
    // ECS takes a while to move a task from stopping to stopped.
    ecs.port.stopTask = async () => undefined;
    let polls = 0;

    await stopping(ecs, async () => {
      polls += 1;
      if (polls === 3) ecs.finish(task);
    });

    expect(polls).toBe(3);
  });

  it('names a task that could not be stopped, after trying the rest', async () => {
    const ecs = fakeEcs();
    await started(ecs);
    await started(ecs);
    const stopTask = ecs.port.stopTask;
    ecs.port.stopTask = async (arn, reason) => {
      if (arn.endsWith('task-1')) throw new Error('access denied');
      await stopTask(arn, reason);
    };

    await expect(stopping(ecs)).rejects.toThrow('task-1 could not be stopped (access denied)');
    expect(ecs.tasks[1]?.stopped).toBe(true);
  });

  it('names a task still running when the wait is over', async () => {
    const ecs = fakeEcs();
    await started(ecs);
    ecs.port.stopTask = async () => undefined;

    await expect(stopping(ecs)).rejects.toThrow('task-1 was still running after the wait');
  });
});

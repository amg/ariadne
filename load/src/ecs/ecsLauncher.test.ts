import { describe, expect, it } from 'vitest';
import { TaskMayStillRun } from '../run/index.ts';
import type { TaskInfo } from '../types/archive.ts';
import type { GeneratorStart } from '../types/run.ts';
import { ecsLauncher } from './ecsLauncher.ts';
import type { Placement } from './ecsPort.ts';
import { fakeEcs } from './fakeEcs.ts';

const start: GeneratorStart = {
  generator: 2,
  attempt: 1,
  firstUser: 500,
  userCount: 250,
  rampSeconds: 120,
  holdSeconds: 600,
  endsAt: null,
  thinkSeconds: 30,
  timeoutMs: 840_000,
};

const never = new AbortController().signal;
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

function setup(
  input: { placement?: Placement; launchDeadlineMs?: number; mode?: 'load' | 'seed' } = {},
) {
  const ecs = fakeEcs();
  const kept: TaskInfo[] = [];
  const warnings: string[] = [];
  const launcher = ecsLauncher({
    ecs: ecs.port,
    runId: 'run-1',
    mode: input.mode ?? 'load',
    placement: input.placement ?? 'spot',
    keepStoppedTask: async (task) => {
      kept.push(task);
    },
    warn: (line) => warnings.push(line),
    pollEveryMs: 1,
    sleep: nextTurn,
    launchDeadlineMs: input.launchDeadlineMs,
  });
  return { ecs, kept, warnings, launcher };
}

describe('starting a generator', () => {
  it('asks for Spot first, and gives the slice and the plan as the task’s environment', async () => {
    const { ecs, launcher } = setup();

    const generator = await launcher.launch(start, never);

    expect(generator.spot).toBe(true);
    expect(generator.task).toBe('task-1');
    expect(ecs.tasks[0]).toMatchObject({
      placement: 'spot',
      environment: {
        RUN_ID: 'run-1',
        MODE: 'load',
        GENERATOR: '2',
        ATTEMPT: '1',
        FIRST_USER: '500',
        USER_COUNT: '250',
        RAMP_SECONDS: '120',
        HOLD_SECONDS: '600',
        THINK_SECONDS: '30',
      },
    });
  });

  it('tells a seeding generator its mode', async () => {
    const { ecs, launcher } = setup({ mode: 'seed', placement: 'on-demand' });

    await launcher.launch(start, never);

    expect(ecs.tasks[0]?.environment.MODE).toBe('seed');
  });

  it('gives the moment the plan ends as the task’s environment, when it has one', async () => {
    const { ecs, launcher } = setup();

    await launcher.launch({ ...start, endsAt: Date.parse('2026-10-17T00:05:00.000Z') }, never);

    expect(ecs.tasks[0]?.environment.ENDS_AT).toBe('2026-10-17T00:05:00.000Z');
    expect(ecs.tasks[0]?.environment).toMatchObject({ RAMP_SECONDS: '120', HOLD_SECONDS: '600' });
  });

  it('gives no end moment to a plan that has none', async () => {
    const { ecs, launcher } = setup();

    await launcher.launch(start, never);

    expect(ecs.tasks[0]?.environment).not.toHaveProperty('ENDS_AT');
  });

  it('falls back to On-Demand when Spot has no capacity, and says so in what it launched', async () => {
    const { ecs, launcher } = setup();
    ecs.state.noCapacityOn.add('spot');

    const generator = await launcher.launch(start, never);

    expect(generator.spot).toBe(false);
    expect(ecs.tasks.map((task) => task.placement)).toEqual(['on-demand']);
  });

  it('does not ask for On-Demand when ECS refused for any other reason', async () => {
    const { ecs, launcher } = setup();
    ecs.state.refuseWith = 'RESOURCE:CPU';

    await expect(launcher.launch(start, never)).rejects.toThrow('RESOURCE:CPU');
    expect(ecs.tasks).toHaveLength(0);
  });

  it('fails when neither Spot nor On-Demand has capacity', async () => {
    const { ecs, launcher } = setup();
    ecs.state.noCapacityOn.add('spot').add('on-demand');

    await expect(launcher.launch(start, never)).rejects.toThrow('Capacity is unavailable');
  });

  it('asks only for On-Demand when that is the placement', async () => {
    const { ecs, launcher } = setup({ placement: 'on-demand' });
    ecs.state.noCapacityOn.add('spot');

    const generator = await launcher.launch(start, never);

    expect(generator.spot).toBe(false);
    expect(ecs.tasks[0]?.placement).toBe('on-demand');
  });
});

describe('when a generator is up', () => {
  it('is launched only once its task is running, so that its plan counts from then', async () => {
    const { ecs, launcher } = setup();
    ecs.state.startSlowly = true;
    let launched = false;

    const launching = Promise.resolve(launcher.launch(start, never)).then((generator) => {
      launched = true;
      return generator;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(launched).toBe(false);

    ecs.markRunning(ecs.taskOf(2));
    expect((await launching).task).toBe('task-1');
  });

  it('is launched, and ended, when its task stops without ever running', async () => {
    const { ecs, launcher } = setup();
    ecs.state.startSlowly = true;

    const launching = Promise.resolve(launcher.launch(start, never));
    await new Promise((resolve) => setTimeout(resolve, 5));
    ecs.fail(ecs.taskOf(2));

    const generator = await launching;
    expect(await generator.ended).toMatchObject({ how: 'stopped', reason: 'failed' });
  });
});

describe('a launch that does not get up', () => {
  it('stops a task stuck before running at its deadline, and fails the launch', async () => {
    const { ecs, launcher } = setup({ launchDeadlineMs: 20 });
    ecs.state.startSlowly = true;

    await expect(launcher.launch(start, never)).rejects.toThrow(
      /was not running .* so it was stopped/,
    );

    expect(ecs.taskOf(2).stopped).toBe(true);
    expect(ecs.taskOf(2).stoppedReason).toContain('not running in time');
  });

  it('says so when the stuck task could not be stopped either', async () => {
    const { ecs, launcher, warnings } = setup({ launchDeadlineMs: 20 });
    ecs.state.startSlowly = true;
    ecs.state.stopFails = new Error('AccessDenied');

    await expect(launcher.launch(start, never)).rejects.toBeInstanceOf(TaskMayStillRun);
    expect(warnings).toEqual([expect.stringContaining('AccessDenied')]);
  });

  it('keeps the stuck task once it has stopped', async () => {
    const { ecs, kept, launcher } = setup({ launchDeadlineMs: 20 });
    ecs.state.startSlowly = true;

    await Promise.resolve(launcher.launch(start, never)).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(kept.map((task) => task.taskId)).toEqual(['task-1']);
  });

  it('does not wait for a task that is starting when the run is interrupted, and stops it', async () => {
    const { ecs, launcher } = setup();
    ecs.state.startSlowly = true;
    const interrupt = new AbortController();

    const launching = launcher.launch(start, interrupt.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    interrupt.abort(new Error('SIGINT'));

    await expect(launching).rejects.toThrow('SIGINT');
    expect(ecs.taskOf(2).stopped).toBe(true);
  });

  it('asks ECS for no task when the run has been interrupted already', async () => {
    const { ecs, launcher } = setup();
    const interrupt = new AbortController();
    interrupt.abort(new Error('SIGINT'));

    await expect(launcher.launch(start, interrupt.signal)).rejects.toThrow('SIGINT');
    expect(ecs.tasks).toHaveLength(0);
  });
});

describe('how a generator ends', () => {
  it('finishes when its container exited cleanly of its own accord', async () => {
    const { ecs, launcher } = setup();
    const generator = await launcher.launch(start, never);

    ecs.finish(ecs.taskOf(2));

    expect(await generator.ended).toEqual({ how: 'finished', report: null });
  });

  it('is stopped as interrupted when Spot takes the capacity back, though its container exited cleanly', async () => {
    const { ecs, launcher } = setup();
    const generator = await launcher.launch(start, never);

    ecs.spotTakesBack(ecs.taskOf(2));

    expect(await generator.ended).toEqual({
      how: 'stopped',
      reason: 'interrupted',
      detail: 'SpotInterruption: Your Spot Task was interrupted.',
      report: null,
    });
  });

  it('is stopped as interrupted when someone stops its task by hand', async () => {
    const { ecs, launcher } = setup();
    const generator = await launcher.launch(start, never);

    ecs.stopByHand(ecs.taskOf(2));

    expect(await generator.ended).toMatchObject({
      how: 'stopped',
      reason: 'interrupted',
      detail: 'UserInitiated: Stopped by hand',
    });
  });

  it('fails when its container exited with an error, naming the exit code', async () => {
    const { ecs, launcher } = setup();
    const generator = await launcher.launch(start, never);

    ecs.fail(ecs.taskOf(2));

    expect(await generator.ended).toMatchObject({
      how: 'stopped',
      reason: 'failed',
      detail: expect.stringContaining('it exited with 1'),
    });
  });

  it('fails when ECS no longer knows its task, and stops the task so its slice is not loaded twice', async () => {
    const { ecs, launcher } = setup();
    const generator = await launcher.launch(start, never);

    ecs.state.forgotten.add(ecs.taskOf(2).arn);
    const end = await generator.ended;

    expect(end).toMatchObject({ how: 'stopped', reason: 'failed' });
    expect(end).not.toHaveProperty('mayStillRun');
    expect(ecs.taskOf(2).stopped).toBe(true);
  });

  it('marks a generator that ECS cannot be asked about and cannot stop as possibly still running', async () => {
    const { ecs, launcher } = setup();
    const generator = await launcher.launch(start, never);

    ecs.state.describeFails = new Error('ThrottlingException');
    ecs.state.stopFails = new Error('ThrottlingException');

    expect(await generator.ended).toMatchObject({
      how: 'stopped',
      reason: 'failed',
      mayStillRun: true,
    });
  });

  it('is stopped as timed out when it outlasts its plan', async () => {
    const { ecs, launcher } = setup();
    const generator = await launcher.launch({ ...start, timeoutMs: 20 }, never);

    const end = await generator.ended;

    expect(end).toMatchObject({ how: 'stopped', reason: 'timed-out' });
    expect(ecs.taskOf(2).stopped).toBe(true);
  });

  it('gives up on generators when ECS has not answered a dozen times in a row', async () => {
    const { ecs, launcher, warnings } = setup();
    const generator = await launcher.launch(start, never);

    ecs.state.describeFails = new Error('ThrottlingException');

    expect(await generator.ended).toMatchObject({ how: 'stopped', reason: 'failed' });
    expect(warnings).toEqual([expect.stringContaining('ThrottlingException')]);
    expect(ecs.taskOf(2).stopped).toBe(true);
  });
});

describe('keeping stopped tasks', () => {
  it('keeps each task as ECS described it when it stopped, whatever stopped it', async () => {
    const { ecs, kept, launcher } = setup();
    const lost = await launcher.launch(start, never);
    const done = await launcher.launch({ ...start, generator: 3 }, never);

    ecs.stopByHand(ecs.taskOf(2));
    ecs.finish(ecs.taskOf(3));
    await Promise.all([lost.ended, done.ended]);

    expect(kept.map((task) => [task.taskId, task.stopCode])).toEqual([
      ['task-1', 'UserInitiated'],
      ['task-2', 'EssentialContainerExited'],
    ]);
    expect(kept[0]?.stoppedReason).toBe('Stopped by hand');
  });

  it('ends the generator all the same when the task could not be kept, and says so', async () => {
    const ecs = fakeEcs();
    const warnings: string[] = [];
    const launcher = ecsLauncher({
      ecs: ecs.port,
      runId: 'run-1',
      mode: 'load',
      placement: 'spot',
      keepStoppedTask: async () => {
        throw new Error('the vault is out of reach');
      },
      warn: (line) => warnings.push(line),
      pollEveryMs: 1,
      sleep: nextTurn,
    });
    const generator = await launcher.launch(start, never);

    ecs.finish(ecs.taskOf(2));

    expect(await generator.ended).toEqual({ how: 'finished', report: null });
    expect(warnings).toEqual([expect.stringContaining('the vault is out of reach')]);
  });
});

describe('stopping a generator', () => {
  it('stops its task, and resolves once the task has stopped', async () => {
    const { ecs, launcher } = setup();
    const generator = await launcher.launch(start, never);

    await generator.stop();

    expect(ecs.taskOf(2).stopped).toBe(true);
    expect(ecs.taskOf(2).stoppedReason).toContain('stopped this generator');
  });

  it('asks ECS for nothing when the generator has ended already', async () => {
    const { ecs, launcher, warnings } = setup();
    const generator = await launcher.launch(start, never);
    ecs.finish(ecs.taskOf(2));
    await generator.ended;

    await generator.stop();

    expect(ecs.taskOf(2).stopCode).toBe('EssentialContainerExited');
    expect(warnings).toEqual([]);
  });
});

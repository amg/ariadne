import { describe, expect, it } from 'vitest';
import { STOPPED_FOR_RUN_END } from '../../records/index.ts';
import type { TaskInfo } from '../../types/archive.ts';
import { outcomeOfGenerators, runEventsOf, stopOf, taskStopEventsOf } from './runEvents.ts';

const task = (overrides: Partial<TaskInfo> = {}) => ({
  taskId: 't1',
  cluster: 'load',
  createdAt: '2026-10-15T00:00:00.000Z',
  startedAt: '2026-10-15T00:00:30.000Z',
  stoppingAt: null,
  stoppedAt: '2026-10-15T00:10:00.000Z',
  stopCode: 'EssentialContainerExited',
  stoppedReason: 'Essential container in task exited',
  exitCode: 0,
  capacityProvider: null,
  environment: { GENERATOR: '0', FIRST_USER: '0', USER_COUNT: '100' },
  ...overrides,
});

const events = (tasks: TaskInfo[]) =>
  runEventsOf({
    startedAt: '2026-10-15T00:00:00.000Z',
    endedAt: '2026-10-15T00:11:00.000Z',
    outcome: 'finished',
    plan: { rampSeconds: 120, holdSeconds: 480 },
    tasks,
  });

describe('stopOf', () => {
  it('calls a task that exited cleanly finished', () => {
    expect(stopOf(task())).toEqual({ reason: 'finished', detail: null });
  });

  it('calls a task that Spot took back interrupted, though its container exited cleanly after reporting', () => {
    expect(
      stopOf(
        task({ stopCode: 'SpotInterruption', stoppedReason: 'Your Spot Task was interrupted.' }),
      ),
    ).toEqual({
      reason: 'interrupted',
      detail: 'SpotInterruption: Your Spot Task was interrupted.',
    });
  });

  it('calls a task someone stopped interrupted', () => {
    expect(
      stopOf(task({ stopCode: 'UserInitiated', stoppedReason: 'by hand', exitCode: 137 })),
    ).toEqual({
      reason: 'interrupted',
      detail: 'UserInitiated: by hand',
    });
  });

  it('calls a task that exited with an error failed, with what ECS said and the exit code', () => {
    expect(stopOf(task({ exitCode: 1 }))).toEqual({
      reason: 'failed',
      detail: 'EssentialContainerExited: Essential container in task exited (it exited with 1)',
    });
  });

  it('calls a task that never started failed, with the reason it gave', () => {
    expect(
      stopOf(
        task({
          exitCode: null,
          stopCode: 'TaskFailedToStart',
          stoppedReason: 'CannotPullContainerError',
        }),
      ),
    ).toEqual({
      reason: 'failed',
      detail: 'TaskFailedToStart: CannotPullContainerError (it never exited)',
    });
  });
});

describe('runEventsOf', () => {
  it('opens with the run’s start and closes with its end and how it ended', () => {
    const all = events([]);

    expect(all[0]).toEqual({ kind: 'run-started', at: '2026-10-15T00:00:00.000Z' });
    expect(all.at(-1)).toEqual({
      kind: 'run-ended',
      at: '2026-10-15T00:11:00.000Z',
      outcome: 'finished',
    });
  });

  it('records each generator’s launch with its slice, its task, its capacity and the plan from when it started', () => {
    const [, launched] = events([task({ capacityProvider: 'FARGATE_SPOT' })]);

    expect(launched).toEqual({
      kind: 'generator-launched',
      at: '2026-10-15T00:00:30.000Z',
      generator: 0,
      attempt: 1,
      firstUser: 0,
      userCount: 100,
      task: 't1',
      spot: true,
      planned: {
        rampEndsAt: '2026-10-15T00:02:30.000Z',
        holdEndsAt: '2026-10-15T00:10:30.000Z',
      },
    });
  });

  it('records when a stopped generator was told to stop, ahead of when its task was torn down', () => {
    const [, , stopped] = events([
      task({
        stoppingAt: '2026-10-15T00:09:20.000Z',
        stopCode: 'SpotInterruption',
        stoppedReason: 'Your Spot Task was interrupted.',
      }),
    ]);

    expect(stopped).toMatchObject({
      kind: 'generator-stopped',
      at: '2026-10-15T00:10:00.000Z',
      toldToStopAt: '2026-10-15T00:09:20.000Z',
      stoppedForRunEnd: false,
    });
  });

  it('marks a generator stopped by the load command’s own clean-up as stopped for the run’s end', () => {
    const [, , stopped] = events([
      task({
        stopCode: 'UserInitiated',
        stoppedReason: `${STOPPED_FOR_RUN_END}: the command ended (interrupted)`,
        exitCode: 143,
      }),
    ]);

    expect(stopped).toMatchObject({ stoppedForRunEnd: true });
  });

  it('marks a generator the load command stopped for the run’s end, and no other', () => {
    const all = events([
      task({
        taskId: 't1',
        stopCode: 'UserInitiated',
        stoppedReason: STOPPED_FOR_RUN_END,
        exitCode: 143,
      }),
      task({
        taskId: 't2',
        environment: { GENERATOR: '1', FIRST_USER: '100', USER_COUNT: '100' },
        stopCode: 'UserInitiated',
        stoppedReason: 'Task stopped by user',
        exitCode: 143,
      }),
    ]);
    const stops = all
      .filter((event) => event.kind === 'generator-stopped')
      .map((event) => [event.generator, event.stoppedForRunEnd]);

    expect(stops).toEqual([
      [0, true],
      [1, false],
    ]);
  });

  it('plans a replacement by the ramp and hold it was started with, not by the step’s', () => {
    const [, launched] = events([
      task({
        environment: {
          GENERATOR: '0',
          ATTEMPT: '2',
          FIRST_USER: '0',
          USER_COUNT: '100',
          RAMP_SECONDS: '60',
          HOLD_SECONDS: '240',
        },
      }),
    ]);

    expect(launched).toMatchObject({
      planned: {
        rampEndsAt: '2026-10-15T00:01:30.000Z',
        holdEndsAt: '2026-10-15T00:05:30.000Z',
      },
    });
  });

  it('ends a replacement’s plan at the moment it was given, however late the task started', () => {
    const [, launched] = events([
      task({
        environment: {
          GENERATOR: '0',
          ATTEMPT: '2',
          FIRST_USER: '0',
          USER_COUNT: '100',
          RAMP_SECONDS: '60',
          HOLD_SECONDS: '240',
          ENDS_AT: '2026-10-15T00:03:00.000Z',
        },
      }),
    ]);

    expect(launched).toMatchObject({
      planned: {
        rampEndsAt: '2026-10-15T00:01:30.000Z',
        holdEndsAt: '2026-10-15T00:03:00.000Z',
      },
    });
  });

  it('never plans a ramp past the moment the plan ends', () => {
    const [, launched] = events([
      task({
        environment: {
          GENERATOR: '0',
          ATTEMPT: '2',
          RAMP_SECONDS: '60',
          HOLD_SECONDS: '240',
          ENDS_AT: '2026-10-15T00:00:50.000Z',
        },
      }),
    ]);

    expect(launched).toMatchObject({
      planned: {
        rampEndsAt: '2026-10-15T00:00:50.000Z',
        holdEndsAt: '2026-10-15T00:00:50.000Z',
      },
    });
  });

  it('plans nothing for a generator that has no ramp or hold', () => {
    const [, launched] = runEventsOf({
      startedAt: '2026-10-15T00:00:00.000Z',
      endedAt: '2026-10-15T00:11:00.000Z',
      outcome: 'finished',
      plan: { rampSeconds: 0, holdSeconds: 0 },
      tasks: [task()],
    });

    expect(launched).toMatchObject({ planned: null });
  });

  it('counts a task that never started from when it was created', () => {
    const [, launched] = events([task({ startedAt: null })]);

    expect(launched).toMatchObject({ at: '2026-10-15T00:00:00.000Z' });
  });

  it('leaves a task that is still running without a stop', () => {
    expect(events([task({ stoppedAt: null })]).map((event) => event.kind)).toEqual([
      'run-started',
      'generator-launched',
      'run-ended',
    ]);
  });

  it('joins a stopped generator to its replacement, which is the next attempt at its slice', () => {
    const lost = task({
      stopCode: 'SpotInterruption',
      stoppedAt: '2026-10-15T00:05:00.000Z',
    });
    const replacement = task({
      taskId: 't2',
      startedAt: '2026-10-15T00:05:10.000Z',
      environment: { GENERATOR: '0', ATTEMPT: '2', FIRST_USER: '0', USER_COUNT: '100' },
    });

    const stops = events([replacement, lost]).filter((event) => event.kind === 'generator-stopped');

    expect(stops).toEqual([
      expect.objectContaining({ attempt: 1, reason: 'interrupted', replacedByAttempt: 2 }),
      expect.objectContaining({ attempt: 2, reason: 'finished', replacedByAttempt: null }),
    ]);
  });

  it('joins a generator to the next attempt that ran, when launches in between were not tasks', () => {
    const lost = task({ stopCode: 'SpotInterruption' });
    const replacement = task({
      taskId: 't2',
      environment: { GENERATOR: '0', ATTEMPT: '3', FIRST_USER: '0', USER_COUNT: '100' },
    });

    const stops = events([lost, replacement]).filter((event) => event.kind === 'generator-stopped');

    expect(stops[0]).toMatchObject({ attempt: 1, replacedByAttempt: 3 });
  });

  it('leaves out a task that was stopped from outside before it ever ran', () => {
    const stuck = task({
      taskId: 't2',
      startedAt: null,
      stopCode: 'UserInitiated',
      stoppedReason: 'The generator was not running in time and was stopped',
      exitCode: null,
      environment: { GENERATOR: '0', ATTEMPT: '2', FIRST_USER: '0', USER_COUNT: '100' },
    });
    const replacement = task({
      taskId: 't3',
      environment: { GENERATOR: '0', ATTEMPT: '3', FIRST_USER: '0', USER_COUNT: '100' },
    });
    const lost = task({ stopCode: 'SpotInterruption' });

    const all = events([lost, stuck, replacement]);

    expect(all.filter((event) => event.kind === 'generator-launched')).toHaveLength(2);
    expect(all.find((event) => event.kind === 'generator-stopped')).toMatchObject({
      attempt: 1,
      replacedByAttempt: 3,
    });
  });

  it('leaves out a task that is no generator’s', () => {
    expect(events([task({ environment: {} })]).map((event) => event.kind)).toEqual([
      'run-started',
      'run-ended',
    ]);
  });
});

describe('taskStopEventsOf', () => {
  it('records why each stopped task stopped, and nothing for one still running', () => {
    expect(taskStopEventsOf([task({ stoppedAt: null }), task({ exitCode: 1 })])).toEqual([
      {
        at: '2026-10-15T00:10:00.000Z',
        source: 'task-stop',
        resource: 'load/t1',
        summary: 'EssentialContainerExited: Essential container in task exited',
        detail: {
          exitCode: 1,
          createdAt: '2026-10-15T00:00:00.000Z',
          startedAt: '2026-10-15T00:00:30.000Z',
          capacityProvider: null,
        },
      },
    ]);
  });
});

describe('outcomeOfGenerators', () => {
  it('is finished when every generator finished', () => {
    expect(
      outcomeOfGenerators([task(), task({ taskId: 't2', environment: { GENERATOR: '1' } })]),
    ).toBe('finished');
  });

  it('is interrupted when one was stopped from outside, and failed when one failed', () => {
    const interrupted = task({ stopCode: 'SpotInterruption' });
    const failed = task({ taskId: 't2', exitCode: 1, environment: { GENERATOR: '1' } });

    expect(outcomeOfGenerators([task(), interrupted])).toBe('interrupted');
    expect(outcomeOfGenerators([interrupted, failed])).toBe('failed');
  });

  it('leaves out a task still running, and finishes for a run with no generators', () => {
    expect(outcomeOfGenerators([task({ stoppedAt: null, exitCode: null })])).toBe('finished');
    expect(outcomeOfGenerators([])).toBe('finished');
  });
});

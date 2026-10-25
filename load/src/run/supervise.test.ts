import { describe, expect, it } from 'vitest';
import type { Report } from '../records/index.ts';
import type { GeneratorEnd, GeneratorLauncher, GeneratorStart } from '../types/run.ts';
import type { GeneratorEvent } from '../types/run.ts';
import { GeneratorDidNotFinish, TaskMayStillRun } from './launcher.ts';
import { sliceUsers } from './slices.ts';
import { superviseStage } from './supervise.ts';

const T0 = Date.parse('2026-10-17T00:00:00.000Z');
const seconds = (count: number) => T0 + count * 1_000;

const reportOf = (generator: number, attempt: number, interrupted = false): Report => ({
  runId: 'run-1',
  generator,
  attempt,
  startedAt: new Date(T0).toISOString(),
  endedAt: new Date(T0).toISOString(),
  interrupted,
  requests: { total: 0, byKind: {} },
  phases: null,
});

/** Launches generators that end only when the test says so. */
function controlledLauncher() {
  const launched: {
    start: GeneratorStart;
    end: (end: GeneratorEnd) => void;
    stopped: boolean;
  }[] = [];
  const launcher: GeneratorLauncher = {
    launch(start) {
      let end: (end: GeneratorEnd) => void = () => undefined;
      const ended = new Promise<GeneratorEnd>((resolve) => {
        end = resolve;
      });
      const entry = { start, end, stopped: false };
      launched.push(entry);
      return {
        task: `fake-${start.generator}-${start.attempt}`,
        spot: false,
        ended,
        async stop() {
          entry.stopped = true;
          end({ how: 'stopped', reason: 'interrupted', detail: 'asked to stop', report: null });
        },
      };
    },
  };
  const find = (generator: number, attempt: number) => {
    const entry = launched.find(
      ({ start }) => start.generator === generator && start.attempt === attempt,
    );
    if (entry === undefined)
      throw new Error(`generator ${generator} attempt ${attempt} not launched`);
    return entry;
  };
  return { launcher, launched, find };
}

function setup(
  input: {
    generators?: number;
    rampSeconds?: number;
    holdSeconds?: number;
    replacesLostGenerators?: boolean;
    launcher?: (controlled: GeneratorLauncher) => GeneratorLauncher;
  } = {},
) {
  const fake = controlledLauncher();
  const events: GeneratorEvent[] = [];
  const said: string[] = [];
  const run = new AbortController();
  let clock = seconds(0);
  const supervise = () =>
    superviseStage({
      launcher: input.launcher?.(fake.launcher) ?? fake.launcher,
      signal: run.signal,
      record: (event) => events.push(event),
      say: (line) => said.push(line),
      stopReasonOf: (cause) => ({ reason: 'interrupted', detail: String(cause) }),
      now: () => clock,
      // A wait costs no time to the test, and the clock moves on by what was waited.
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      slices: sliceUsers({ users: 10, generators: input.generators ?? 2 }),
      rampSeconds: input.rampSeconds ?? 5,
      holdSeconds: input.holdSeconds ?? 295,
      thinkSeconds: 5,
      replacesLostGenerators: input.replacesLostGenerators,
    });
  return {
    ...fake,
    events,
    said,
    run,
    supervise,
    setClock: (second: number) => {
      clock = seconds(second);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const stops = (events: readonly GeneratorEvent[]) =>
  events.flatMap((event) => (event.kind === 'generator-stopped' ? [event] : []));

describe('superviseStage', () => {
  it('starts one generator on each slice and records each stop when they all finish', async () => {
    const test = setup();
    const supervising = test.supervise();
    await settle();

    expect(
      test.launched.map(({ start }) => [start.generator, start.firstUser, start.userCount]),
    ).toEqual([
      [0, 0, 5],
      [1, 5, 5],
    ]);
    test.find(0, 1).end({ how: 'finished', report: reportOf(0, 1) });
    test.find(1, 1).end({ how: 'finished', report: reportOf(1, 1) });

    expect((await supervising).map((report) => report.generator)).toEqual([0, 1]);
    expect(stops(test.events).map(({ generator, reason }) => [generator, reason])).toEqual([
      [0, 'finished'],
      [1, 'finished'],
    ]);
  });

  it('records when each generator was planned to ramp and hold until', async () => {
    const test = setup({ rampSeconds: 5, holdSeconds: 295 });
    const supervising = test.supervise();
    await settle();

    expect(test.events[0]).toMatchObject({
      kind: 'generator-launched',
      at: new Date(seconds(0)).toISOString(),
      task: 'fake-0-1',
      planned: {
        rampEndsAt: new Date(seconds(5)).toISOString(),
        holdEndsAt: new Date(seconds(300)).toISOString(),
      },
    });
    test.run.abort(new Error('stop'));
    await expect(supervising).rejects.toThrow('stop');
  });

  it('replaces a generator that was told to stop on the same slice, for the time the run has left', async () => {
    const test = setup();
    const supervising = test.supervise();
    await settle();

    test.setClock(100);
    test.find(1, 1).end({
      how: 'stopped',
      reason: 'interrupted',
      detail: 'told to stop',
      report: reportOf(1, 1, true),
    });
    await settle();

    expect(test.find(1, 2).start).toMatchObject({
      generator: 1,
      attempt: 2,
      firstUser: 5,
      userCount: 5,
      rampSeconds: 60,
      holdSeconds: 140,
    });
    expect(test.launched).toHaveLength(3);
    expect(stops(test.events)).toEqual([
      {
        kind: 'generator-stopped',
        at: new Date(seconds(100)).toISOString(),
        generator: 1,
        attempt: 1,
        reason: 'interrupted',
        detail: 'told to stop',
        toldToStopAt: null,
        stoppedForRunEnd: false,
        replacedByAttempt: 2,
      },
    ]);
    expect(
      test.events.find((event) => event.kind === 'generator-launched' && event.attempt === 2),
    ).toMatchObject({
      at: new Date(seconds(100)).toISOString(),
      planned: {
        rampEndsAt: new Date(seconds(160)).toISOString(),
        holdEndsAt: new Date(seconds(300)).toISOString(),
      },
    });

    test.setClock(300);
    test.find(0, 1).end({ how: 'finished', report: reportOf(0, 1) });
    test.find(1, 2).end({ how: 'finished', report: reportOf(1, 2) });
    const reports = await supervising;
    expect(reports.map((report) => [report.generator, report.attempt])).toEqual([
      [0, 1],
      [1, 1],
      [1, 2],
    ]);
  });

  it('gives a replacement launched near the end only the time that is left', async () => {
    const test = setup();
    const supervising = test.supervise();
    await settle();

    test.setClock(270);
    test.find(0, 1).end({ how: 'stopped', reason: 'failed', detail: 'killed', report: null });
    await settle();

    expect(test.find(0, 2).start).toMatchObject({ rampSeconds: 30, holdSeconds: 0 });
    test.run.abort(new Error('stop'));
    await expect(supervising).rejects.toThrow('stop');
  });

  it('counts the stage from when its first generator was up, not from when it was asked for', async () => {
    const fake = controlledLauncher();
    let clock = seconds(0);
    const launcher: GeneratorLauncher = {
      launch: async (start, signal) => {
        clock = seconds(60);
        return fake.launcher.launch(start, signal);
      },
    };
    const supervising = superviseStage({
      launcher,
      signal: new AbortController().signal,
      record: () => undefined,
      say: () => undefined,
      stopReasonOf: () => ({ reason: 'interrupted', detail: null }),
      now: () => clock,
      slices: sliceUsers({ users: 10, generators: 1 }),
      rampSeconds: 5,
      holdSeconds: 295,
      thinkSeconds: 5,
    });
    await settle();

    clock = seconds(270);
    fake.find(0, 1).end({ how: 'stopped', reason: 'failed', detail: 'killed', report: null });
    await settle();

    expect(fake.find(0, 2).start).toMatchObject({ rampSeconds: 60, holdSeconds: 30 });
    fake.find(0, 2).end({ how: 'finished', report: reportOf(0, 2) });
    await supervising;
  });

  it('leaves a slice down when too little of the run is left to bring it back', async () => {
    const test = setup();
    const supervising = test.supervise();
    await settle();

    test.setClock(297);
    test.find(0, 1).end({ how: 'stopped', reason: 'failed', detail: 'killed', report: null });
    await settle();
    test.find(1, 1).end({ how: 'finished', report: reportOf(1, 1) });
    await supervising;

    expect(test.launched).toHaveLength(2);
    expect(stops(test.events)[0]).toMatchObject({
      generator: 0,
      reason: 'failed',
      replacedByAttempt: null,
    });
  });

  it('stops the other generators and gives up when one outlasts its time', async () => {
    const test = setup();
    const supervising = test.supervise();
    await settle();

    test.find(0, 1).end({ how: 'stopped', reason: 'timed-out', detail: 'too late', report: null });

    await expect(supervising).rejects.toBeInstanceOf(GeneratorDidNotFinish);
    expect(test.find(1, 1).stopped).toBe(true);
    expect(
      stops(test.events).map(({ generator, reason, stoppedForRunEnd }) => [
        generator,
        reason,
        stoppedForRunEnd,
      ]),
    ).toEqual([
      [0, 'timed-out', false],
      [1, 'interrupted', true],
    ]);
  });

  it('stops the other generators and gives up when one stops early in a stage that does not replace', async () => {
    const test = setup({ replacesLostGenerators: false });
    const supervising = test.supervise();
    await settle();

    test.find(0, 1).end({ how: 'stopped', reason: 'interrupted', detail: 'by hand', report: null });

    await expect(supervising).rejects.toThrow(/does not replace a lost generator/);
    expect(test.find(1, 1).stopped).toBe(true);
    expect(test.launched).toHaveLength(2);
  });

  it('gives up on a slice that keeps stopping, after trying it four times', async () => {
    const test = setup({ generators: 1 });
    const supervising = test.supervise();
    for (const attempt of [1, 2, 3, 4]) {
      await settle();
      test
        .find(0, attempt)
        .end({ how: 'stopped', reason: 'failed', detail: 'crashed', report: null });
    }

    await expect(supervising).rejects.toThrow(/stopped 4 times/);
    expect(test.launched).toHaveLength(4);
  });

  it('stops every generator and says why when the run ends', async () => {
    const test = setup();
    const supervising = test.supervise();
    await settle();

    test.run.abort(new Error('the guard'));

    await expect(supervising).rejects.toThrow('the guard');
    expect(test.launched.every(({ stopped }) => stopped)).toBe(true);
    expect(stops(test.events)).toHaveLength(2);
    expect(stops(test.events)[0]).toMatchObject({
      reason: 'interrupted',
      detail: 'Error: the guard',
      stoppedForRunEnd: true,
      replacedByAttempt: null,
    });
  });

  it('stops the other generators and gives up when one cannot be started', async () => {
    const fake = controlledLauncher();
    const events: GeneratorEvent[] = [];
    const launcher: GeneratorLauncher = {
      launch: async (start, signal) => {
        if (start.generator === 1) throw new Error('no capacity anywhere');
        return fake.launcher.launch(start, signal);
      },
    };

    await expect(
      superviseStage({
        launcher,
        signal: new AbortController().signal,
        record: (event) => events.push(event),
        say: () => undefined,
        stopReasonOf: () => ({ reason: 'interrupted', detail: null }),
        slices: sliceUsers({ users: 10, generators: 2 }),
        rampSeconds: 5,
        holdSeconds: 295,
        thinkSeconds: 5,
      }),
    ).rejects.toThrow(/Generator 1 attempt 1 could not be started: no capacity anywhere/);
    expect(fake.find(0, 1).stopped).toBe(true);
    expect(stops(events).map(({ generator, reason }) => [generator, reason])).toEqual([
      [0, 'interrupted'],
    ]);
  });

  it('launches nothing for a run that has already ended', async () => {
    const test = setup();
    test.run.abort(new Error('the guard'));

    await expect(test.supervise()).rejects.toThrow('the guard');
    expect(test.launched).toHaveLength(0);
  });

  it('gives a replacement the moment the stage ends, so a slow launch cannot push it past', async () => {
    const test = setup({
      launcher: (controlled) => ({
        launch: async (start, signal) => {
          if (start.attempt > 1) test.setClock(160);
          return controlled.launch(start, signal);
        },
      }),
    });
    const supervising = test.supervise();
    await settle();
    expect(test.find(1, 1).start.endsAt).toBeNull();

    test.setClock(100);
    test.find(1, 1).end({ how: 'stopped', reason: 'failed', detail: 'killed', report: null });
    await settle();

    expect(test.find(1, 2).start.endsAt).toBe(seconds(300));
    expect(
      test.events.find((event) => event.kind === 'generator-launched' && event.attempt === 2),
    ).toMatchObject({
      at: new Date(seconds(160)).toISOString(),
      planned: {
        rampEndsAt: new Date(seconds(220)).toISOString(),
        holdEndsAt: new Date(seconds(300)).toISOString(),
      },
    });
    test.setClock(300);
    test.find(0, 1).end({ how: 'finished', report: null });
    test.find(1, 2).end({ how: 'finished', report: null });
    await supervising;
  });

  it('leaves a slice down, names the gap, and completes the run when a replacement cannot be launched', async () => {
    const test = setup({
      launcher: (controlled) => ({
        launch: async (start, signal) => {
          if (start.attempt > 1) throw new Error('Capacity is unavailable at this time');
          return controlled.launch(start, signal);
        },
      }),
    });
    const supervising = test.supervise();
    await settle();

    test.setClock(100);
    test
      .find(1, 1)
      .end({ how: 'stopped', reason: 'interrupted', detail: 'told to stop', report: null });
    await settle();
    test.find(0, 1).end({ how: 'finished', report: reportOf(0, 1) });

    expect((await supervising).map((report) => report.generator)).toEqual([0]);
    expect(test.launched).toHaveLength(2);
    expect(stops(test.events).find((stop) => stop.generator === 1)).toMatchObject({
      at: new Date(seconds(100)).toISOString(),
      reason: 'interrupted',
      detail: 'told to stop; it could not be replaced: Capacity is unavailable at this time',
      replacedByAttempt: null,
    });
    expect(test.said.some((line) => line.includes('stays down'))).toBe(true);
  });

  it('tries a replacement again, under a new attempt number, and records the one that started', async () => {
    let refused = 1;
    const test = setup({
      launcher: (controlled) => ({
        launch: async (start, signal) => {
          if (start.attempt > 1 && refused-- > 0) throw new Error('Capacity is unavailable');
          return controlled.launch(start, signal);
        },
      }),
    });
    const supervising = test.supervise();
    await settle();

    test.setClock(100);
    test.find(1, 1).end({ how: 'stopped', reason: 'failed', detail: 'killed', report: null });
    await settle();

    expect(test.find(1, 3).start).toMatchObject({ generator: 1, endsAt: seconds(300) });
    expect(stops(test.events)[0]).toMatchObject({ attempt: 1, replacedByAttempt: 3 });
    test.run.abort(new Error('stop'));
    await expect(supervising).rejects.toThrow('stop');
  });

  it('does not try a replacement again when a failed launch left a task it could not stop', async () => {
    const test = setup({
      launcher: (controlled) => ({
        launch: async (start, signal) => {
          if (start.attempt > 1)
            throw new TaskMayStillRun('Task task-9 was not running, and it could not be stopped');
          return controlled.launch(start, signal);
        },
      }),
    });
    const supervising = test.supervise();
    await settle();

    test.setClock(100);
    test.find(1, 1).end({ how: 'stopped', reason: 'failed', detail: 'killed', report: null });
    await settle();
    test.find(0, 1).end({ how: 'finished', report: null });
    await supervising;

    expect(test.said.filter((line) => line.includes('could not be started'))).toEqual([]);
    expect(stops(test.events).find((stop) => stop.generator === 1)).toMatchObject({
      replacedByAttempt: null,
      detail: expect.stringContaining('it could not be stopped'),
    });
  });

  it('does not replace a generator that could not be stopped, so two never load one slice', async () => {
    const test = setup();
    const supervising = test.supervise();
    await settle();

    test.setClock(100);
    test.find(1, 1).end({
      how: 'stopped',
      reason: 'failed',
      detail: 'ECS could not be asked',
      report: null,
      mayStillRun: true,
    });
    await settle();
    test.find(0, 1).end({ how: 'finished', report: null });
    await supervising;

    expect(test.launched).toHaveLength(2);
    expect(stops(test.events).find((stop) => stop.generator === 1)).toMatchObject({
      replacedByAttempt: null,
    });
    expect(test.said.some((line) => line.includes('could not be stopped'))).toBe(true);
  });

  it('ends at once when the run ends while a replacement is being launched', async () => {
    const test = setup({
      launcher: (controlled) => ({
        launch: (start, signal) =>
          start.attempt === 1
            ? controlled.launch(start, signal)
            : new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason));
              }),
      }),
    });
    const supervising = test.supervise();
    await settle();
    test.find(1, 1).end({ how: 'stopped', reason: 'failed', detail: 'killed', report: null });
    await settle();

    test.run.abort(new Error('the guard'));

    await expect(supervising).rejects.toThrow('the guard');
    expect(test.find(0, 1).stopped).toBe(true);
    expect(stops(test.events).find((stop) => stop.generator === 1)).toMatchObject({
      replacedByAttempt: null,
    });
  });
});

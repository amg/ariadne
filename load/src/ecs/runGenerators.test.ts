import { describe, expect, it } from 'vitest';
import { GeneratorDidNotFinish } from '../run/index.ts';
import type { TaskInfo } from '../types/archive.ts';
import { fakeEcs } from './fakeEcs.ts';
import { Interrupted } from './interruption.ts';
import { runGenerators } from './runGenerators.ts';

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

const STARTED = Date.parse('2026-10-17T00:00:00.000Z');

function setup(input: { generators?: number; users?: number; mode?: 'load' | 'seed' } = {}) {
  const ecs = fakeEcs();
  const kept: TaskInfo[] = [];
  const said: string[] = [];
  const interrupt = new AbortController();
  let clock = STARTED;
  const running = () =>
    runGenerators({
      ecs: ecs.port,
      runId: 'run-1',
      mode: input.mode ?? 'load',
      placement: input.mode === 'seed' ? 'on-demand' : 'spot',
      users: input.users ?? 1_000,
      generators: input.generators ?? 4,
      rampSeconds: 120,
      holdSeconds: 600,
      thinkSeconds: 30,
      signal: interrupt.signal,
      keepStoppedTask: async (task) => {
        kept.push(task);
      },
      say: (line) => said.push(line),
      pollEveryMs: 1,
      // A wait takes no time, and the clock moves on by what was waited.
      sleep: async (milliseconds) => {
        clock += milliseconds;
        await nextTurn();
      },
      now: () => clock,
    });
  return {
    ecs,
    kept,
    said,
    interrupt,
    running,
    setClock: (secondsIn: number) => {
      clock = STARTED + secondsIn * 1_000;
    },
  };
}

/** Waits until `holds` is true, so that a test acts only after the run has got there. */
async function until(holds: () => boolean) {
  for (let turn = 0; turn < 1_000 && !holds(); turn += 1) await nextTurn();
  if (!holds()) throw new Error('the run never got there');
}

/** Whether every generator's first attempt has been launched, which is when the stage's end is set. */
const allStarted = (said: readonly string[], generators: number) =>
  said.filter((line) => line.includes('attempt 1 started')).length === generators;

describe('runGenerators', () => {
  it('starts every generator on Spot, each on its own slice of the users', async () => {
    const { ecs, running } = setup();
    const run = running();
    await until(() => ecs.tasks.length === 4);

    expect(
      ecs.tasks.map(({ placement, environment }) => [
        placement,
        environment.FIRST_USER,
        environment.USER_COUNT,
      ]),
    ).toEqual([
      ['spot', '0', '250'],
      ['spot', '250', '250'],
      ['spot', '500', '250'],
      ['spot', '750', '250'],
    ]);
    for (const task of [...ecs.tasks]) ecs.finish(task);
    await run;
  });

  it('starts a generator that was stopped by hand again on its slice, and keeps why it stopped', async () => {
    const { ecs, kept, running } = setup();
    const run = running();
    await until(() => ecs.tasks.length === 4);

    ecs.stopByHand(ecs.taskOf(2));
    await until(() => ecs.tasks.length === 5);

    const replacement = ecs.taskOf(2, 2);
    expect(replacement.environment).toMatchObject({
      GENERATOR: '2',
      ATTEMPT: '2',
      FIRST_USER: '500',
      USER_COUNT: '250',
      RAMP_SECONDS: '60',
    });
    expect(Number(replacement.environment.HOLD_SECONDS)).toBeGreaterThan(500);
    expect(kept).toEqual([
      expect.objectContaining({ stopCode: 'UserInitiated', stoppedReason: 'Stopped by hand' }),
    ]);

    for (const task of ecs.tasks) ecs.finish(task);
    await run;
    expect(ecs.tasks).toHaveLength(5);
    expect(kept).toHaveLength(5);
  });

  it('starts a generator that Spot took back again, on Spot', async () => {
    const { ecs, running } = setup();
    const run = running();
    await until(() => ecs.tasks.length === 4);

    ecs.spotTakesBack(ecs.taskOf(0));
    await until(() => ecs.tasks.length === 5);

    expect(ecs.taskOf(0, 2).placement).toBe('spot');
    for (const task of ecs.tasks) ecs.finish(task);
    await run;
  });

  it('fails the run when no generator can be started', async () => {
    const { ecs, running } = setup({ generators: 2, users: 10 });
    ecs.state.refuseWith = 'RESOURCE:CPU';

    await expect(running()).rejects.toThrow(GeneratorDidNotFinish);
    expect(ecs.tasks).toHaveLength(0);
  });

  it('stops every generator when the run is interrupted, and rejects with what interrupted it', async () => {
    const { ecs, interrupt, running } = setup();
    const run = running();
    await until(() => ecs.tasks.length === 4);

    interrupt.abort(new Interrupted('The load command received SIGINT'));

    await expect(run).rejects.toThrow('SIGINT');
    expect(ecs.tasks.every((task) => task.stopped)).toBe(true);
  });

  it('ends a replacement with the run, whatever its slow start took', async () => {
    const { ecs, said, running, setClock } = setup();
    const run = running();
    await until(() => allStarted(said, 4));

    setClock(100);
    ecs.state.startSlowly = true;
    ecs.stopByHand(ecs.taskOf(2));
    await until(() => ecs.tasks.length === 5);
    setClock(190);
    ecs.markRunning(ecs.taskOf(2, 2));
    await nextTurn();

    // The stage ends 720 s after its generators were up, not 720 s after the replacement was asked for.
    const endsAt = Date.parse(ecs.taskOf(2, 2).environment.ENDS_AT ?? '');
    expect(Math.abs(endsAt - (STARTED + 720_000))).toBeLessThan(1_000);
    for (const task of ecs.tasks) ecs.finish(task);
    await run;
  });

  it('leaves the slice down and finishes the run when a replacement cannot be launched', async () => {
    const { ecs, kept, said, running, setClock } = setup();
    const run = running();
    await until(() => allStarted(said, 4));

    setClock(100);
    ecs.state.refuseWith = 'RESOURCE:CPU';
    ecs.stopByHand(ecs.taskOf(2));
    await until(() => said.some((line) => line.includes('stays down')));
    for (const task of ecs.tasks) ecs.finish(task);
    await run;

    expect(ecs.tasks).toHaveLength(4);
    expect(said.some((line) => line.includes('RESOURCE:CPU'))).toBe(true);
    expect(kept).toHaveLength(4);
  });

  it('stops a task whose end ECS cannot say before replacing its slice', async () => {
    const { ecs, running } = setup({ generators: 1, users: 10 });
    const run = running();
    await until(() => ecs.tasks.length === 1);

    ecs.state.forgotten.add(ecs.taskOf(0).arn);
    await until(() => ecs.tasks.length === 2);

    expect(ecs.taskOf(0).stopped).toBe(true);
    ecs.state.forgotten.clear();
    for (const task of ecs.tasks) ecs.finish(task);
    await run;
  });

  describe('seeding', () => {
    it('starts every generator On-Demand in seed mode, each on its own slice, and ends when they finish', async () => {
      const { ecs, running } = setup({ mode: 'seed', generators: 2, users: 10 });
      const run = running();
      await until(() => ecs.tasks.length === 2);

      expect(
        ecs.tasks.map(({ placement, environment }) => [
          placement,
          environment.MODE,
          environment.FIRST_USER,
          environment.USER_COUNT,
        ]),
      ).toEqual([
        ['on-demand', 'seed', '0', '5'],
        ['on-demand', 'seed', '5', '5'],
      ]);
      for (const task of [...ecs.tasks]) ecs.finish(task);
      await run;
    });

    it('does not replace a generator that stopped early, and stops the others and fails the run', async () => {
      const { ecs, running } = setup({ mode: 'seed', generators: 2, users: 10 });
      const run = running();
      await until(() => ecs.tasks.length === 2);

      ecs.stopByHand(ecs.taskOf(0));

      await expect(run).rejects.toThrow(GeneratorDidNotFinish);
      expect(ecs.tasks).toHaveLength(2);
      expect(ecs.tasks.every((task) => task.stopped)).toBe(true);
    });
  });
});

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { STOPPED_FOR_RUN_END } from '../records/index.ts';
import { carryOutRun, exitStatusOf } from './carryOutRun.ts';
import { fakeEcs } from './fakeEcs.ts';
import { interruptionOf } from './interruption.ts';
import { runGenerators } from './runGenerators.ts';
import { stopEveryGenerator } from './stopEveryGenerator.ts';

type RunRecord = NonNullable<Parameters<typeof carryOutRun>[0]['recordOrNull']>;

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

/** A load command whose fleet runs in a fake ECS and whose record notes what was done to the run, and whether every generator had stopped by then. */
function loadCommand(input: { mode?: 'load' | 'seed'; record?: RunRecord | null } = {}) {
  const ecs = fakeEcs();
  const signals = new EventEmitter();
  const notes: string[] = [];
  const said: string[] = [];
  const allStopped = () => ecs.tasks.length > 0 && ecs.tasks.every((task) => task.stopped);
  const record: RunRecord | null =
    input.record === undefined
      ? {
          open: async () => {
            notes.push('open');
          },
          seal: async ({ outcome, endedAtOrNull }) => {
            notes.push(
              `seal ${outcome} ${endedAtOrNull === null ? 'when the generators ended' : 'at the command’s end'} (every generator stopped: ${allStopped()})`,
            );
          },
          rebuild: async () => {
            notes.push('rebuild');
          },
        }
      : input.record;
  const signal = interruptionOf(signals, (repeated) => said.push(`again ${repeated}`));
  const running = carryOutRun({
    recordOrNull: record,
    runFleet: () =>
      runGenerators({
        ecs: ecs.port,
        runId: 'run-1',
        mode: input.mode ?? 'load',
        placement: 'spot',
        users: 40,
        generators: 4,
        rampSeconds: 120,
        holdSeconds: 600,
        thinkSeconds: 30,
        signal,
        keepStoppedTask: async () => undefined,
        say: (line) => said.push(line),
        pollEveryMs: 1,
        sleep: nextTurn,
      }),
    stopEveryGenerator: (reason) =>
      stopEveryGenerator({ ecs: ecs.port, reason, pollEveryMs: 1, sleep: nextTurn }),
    say: (line) => said.push(line),
  });
  return { ecs, signals, notes, said, running };
}

async function untilTasksStarted(ecs: ReturnType<typeof fakeEcs>, count: number) {
  for (let turn = 0; turn < 1_000 && ecs.tasks.length < count; turn += 1) await nextTurn();
  if (ecs.tasks.length < count) throw new Error('the generators never started');
}

describe.each(['SIGINT', 'SIGTERM'] as const)('the load command signalled with %s', (signal) => {
  it('stops every generator, then seals the run as interrupted, then rebuilds it', async () => {
    const { ecs, signals, notes, running } = loadCommand();
    await untilTasksStarted(ecs, 4);

    signals.emit(signal);

    expect(await running).toBe('interrupted');
    expect(notes).toEqual([
      'open',
      'seal interrupted at the command’s end (every generator stopped: true)',
      'rebuild',
    ]);
  });
});

describe('the load command when its fleet fails', () => {
  it('stops every generator, then seals the run as failed, then rebuilds it', async () => {
    const { ecs, notes, said, running } = loadCommand();
    ecs.state.refuseWith = 'RESOURCE:CPU';

    expect(await running).toBe('failed');
    expect(said.join('\n')).toContain('RESOURCE:CPU');
    expect(notes).toEqual([
      'open',
      expect.stringMatching(/^seal failed at the command’s end/),
      'rebuild',
    ]);
  });

  it('stops the generators that did start when another could not be kept running', async () => {
    const { ecs, notes, running } = loadCommand();
    await untilTasksStarted(ecs, 4);

    // The supervision starts a generator again on its slice until it has stopped four times.
    ecs.fail(ecs.taskOf(1));
    for (const attempt of [2, 3, 4]) {
      await untilTasksStarted(ecs, 3 + attempt);
      ecs.fail(ecs.taskOf(1, attempt));
    }

    expect(await running).toBe('failed');
    expect(notes).toContain('seal failed at the command’s end (every generator stopped: true)');
  });
});

describe('the load command when its fleet finishes', () => {
  it('seals the run as finished, ending when its generators did, and rebuilds it', async () => {
    const { ecs, notes, running } = loadCommand();
    await untilTasksStarted(ecs, 4);

    for (const task of [...ecs.tasks]) ecs.finish(task);

    expect(await running).toBe('finished');
    expect(notes).toEqual([
      'open',
      'seal finished when the generators ended (every generator stopped: true)',
      'rebuild',
    ]);
  });
});

describe('the load command with a generator its fleet does not know', () => {
  it('stops it before it seals the run, and says the command ended it', async () => {
    const { ecs, notes, running } = loadCommand();
    await untilTasksStarted(ecs, 4);
    await ecs.port.startTask({ placement: 'spot', environment: { GENERATOR: '9' } });

    for (const task of [...ecs.tasks.slice(0, 4)]) ecs.finish(task);

    expect(await running).toBe('finished');
    expect(notes).toContain(
      'seal finished when the generators ended (every generator stopped: true)',
    );
    expect(ecs.tasks[4]?.stoppedReason).toBe(
      `${STOPPED_FOR_RUN_END}: the command ended (finished)`,
    );
  });
});

describe('the load command when a step of its ending fails', () => {
  function ending(
    overrides: Partial<Parameters<typeof carryOutRun>[0]> = {},
    failing: Partial<RunRecord> = {},
  ) {
    const notes: string[] = [];
    const said: string[] = [];
    const record: RunRecord = {
      open: async () => {
        notes.push('open');
      },
      seal: async () => {
        notes.push('seal');
      },
      rebuild: async () => {
        notes.push('rebuild');
      },
      ...failing,
    };
    const running = carryOutRun({
      recordOrNull: record,
      runFleet: async () => {
        notes.push('fleet');
      },
      stopEveryGenerator: async () => {
        notes.push('stop');
      },
      say: (line) => said.push(line),
      ...overrides,
    });
    return { notes, said, record, running };
  }

  it('seals the run as it stands when a generator could not be stopped', async () => {
    const { notes, said, running } = ending({
      stopEveryGenerator: async () => {
        throw new Error('Not every generator was stopped: task-3 could not be stopped');
      },
    });

    expect(await running).toBe('finished');
    expect(notes).toEqual(['open', 'fleet', 'seal', 'rebuild']);
    expect(said.join('\n')).toContain('task-3 could not be stopped');
  });

  it('does not rebuild a run that could not be sealed, and still says how the run ended', async () => {
    const { notes, said, running } = ending(
      {},
      {
        seal: async () => {
          throw new Error('CloudWatch is out of reach');
        },
      },
    );

    expect(await running).toBe('finished');
    expect(notes).toEqual(['open', 'fleet', 'stop']);
    expect(said.join('\n')).toContain('The run is not sealed: CloudWatch is out of reach');
  });

  it('keeps the outcome when the rebuild fails', async () => {
    const { said, running } = ending(
      {},
      {
        rebuild: async () => {
          throw new Error('no manifest');
        },
      },
    );

    expect(await running).toBe('finished');
    expect(said.join('\n')).toContain('The run is sealed but not rebuilt: no manifest');
  });

  it('runs no generator and seals nothing when the run could not be opened', async () => {
    const { notes, said, running } = ending(
      {},
      {
        open: async () => {
          throw new Error('the raise could not be read');
        },
      },
    );

    expect(await running).toBe('failed');
    expect(notes).toEqual([]);
    expect(said.join('\n')).toContain('The run could not begin: the raise could not be read');
  });
});

describe('the seeding command', () => {
  it('stops every generator when it ends, and keeps no record', async () => {
    const { ecs, notes, running } = loadCommand({ mode: 'seed', record: null });
    await untilTasksStarted(ecs, 4);
    await ecs.port.startTask({ placement: 'on-demand', environment: { GENERATOR: '9' } });

    ecs.stopByHand(ecs.taskOf(0));

    expect(await running).toBe('failed');
    expect(ecs.tasks.every((task) => task.stopped)).toBe(true);
    expect(notes).toEqual([]);
  });
});

describe('interruptionOf', () => {
  it('aborts with what the signal was, and hands a signal that follows to the one told of repeats', () => {
    const signals = new EventEmitter();
    const repeated: string[] = [];
    const signal = interruptionOf(signals, (again) => repeated.push(again));

    signals.emit('SIGTERM');
    signals.emit('SIGINT');

    expect(signal.aborted).toBe(true);
    expect(String(signal.reason)).toContain('SIGTERM');
    expect(repeated).toEqual(['SIGINT']);
  });
});

describe('exitStatusOf', () => {
  it('gives 0 for a run that finished, 130 for one that was interrupted and 1 for one that failed', () => {
    expect([exitStatusOf('finished'), exitStatusOf('interrupted'), exitStatusOf('failed')]).toEqual(
      [0, 130, 1],
    );
  });
});

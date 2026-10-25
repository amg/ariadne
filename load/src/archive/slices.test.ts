import { describe, expect, it } from 'vitest';
import type { Report, RunEvent } from '../records/index.ts';
import { type Attempt, attemptsOf } from './attempts.ts';
import { slicesOf } from './slices.ts';

const at = (second: number) => new Date(Date.UTC(2026, 9, 15, 0, 0, second)).toISOString();

const launched = (attempt: number, second: number): RunEvent => ({
  kind: 'generator-launched',
  at: at(second),
  generator: 3,
  attempt,
  firstUser: 15,
  userCount: 5,
  task: `task-${attempt}`,
  spot: true,
  planned: { rampEndsAt: at(second + 10), holdEndsAt: at(second + 40) },
});

const stopped = (attempt: number, second: number, replacedByAttempt: number | null): RunEvent => ({
  kind: 'generator-stopped',
  at: at(second),
  generator: 3,
  attempt,
  reason: replacedByAttempt === null ? 'finished' : 'failed',
  detail: null,
  toldToStopAt: null,
  stoppedForRunEnd: false,
  replacedByAttempt,
});

describe('attemptsOf', () => {
  it('pairs each launch with its stop, and names the attempt that replaced it', () => {
    const attempts = attemptsOf([
      launched(1, 0),
      stopped(1, 20, 2),
      launched(2, 22),
      stopped(2, 60, null),
    ]);

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      generator: 3,
      attempt: 1,
      firstUser: 15,
      userCount: 5,
      spot: true,
      stoppedAt: at(20),
      stoppedBecause: 'failed',
      replacedByAttempt: 2,
    });
    expect(attempts[1]).toMatchObject({
      attempt: 2,
      stoppedBecause: 'finished',
      replacedByAttempt: null,
    });
  });

  it('has no stop for an attempt still running when the events end', () => {
    expect(attemptsOf([launched(1, 0)])[0]).toMatchObject({
      stoppedAt: null,
      stoppedBecause: null,
    });
  });

  it('ignores events that are not about generators', () => {
    expect(attemptsOf([{ kind: 'run-started', at: at(0) }])).toEqual([]);
  });
});

/** One generator of slice 0, users 0 to 9, that ran from second 1 to second 170 and finished. */
function attemptWith(overrides: Partial<Attempt> = {}): Attempt {
  return {
    generator: 0,
    attempt: 1,
    firstUser: 0,
    userCount: 10,
    task: 'pid-1',
    spot: false,
    startedAt: at(1),
    stoppedAt: at(170),
    stoppedBecause: 'finished',
    stopDetail: null,
    toldToStopAt: null,
    stoppedForRunEnd: false,
    replacedByAttempt: null,
    planned: null,
    ...overrides,
  };
}

/** What a run left: no report and no state lines, unless a test gives them; it ended at second 180. */
type SliceSources = Parameters<typeof slicesOf>[1];

function sourcesWith(overrides: Partial<SliceSources> = {}) {
  return { reportOf: () => null, lastStateAt: () => null, runEndedAt: at(180), ...overrides };
}

/** A report whose ramp and hold ran as given, in seconds. */
function reportWith(ramp: [number, number], hold: [number, number]): Report {
  const stretch = ([from, to]: [number, number]) => ({ startedAt: at(from), endedAt: at(to) });
  return {
    runId: 'run-1',
    generator: 0,
    attempt: 2,
    startedAt: at(ramp[0]),
    endedAt: at(hold[1]),
    interrupted: false,
    requests: { total: 0, byKind: {} },
    phases: { ramp: stretch(ramp), hold: stretch(hold), rampDown: stretch([hold[1], hold[1]]) },
  };
}

const downOf = (attempts: readonly Attempt[], sources = sourcesWith()) =>
  slicesOf(attempts, sources).flatMap((slice) => slice.down);

describe('slicesOf', () => {
  const interrupted = attemptWith({
    stoppedAt: at(60),
    stoppedBecause: 'interrupted',
    stopDetail: 'reclaimed',
  });

  it('makes one slice of every attempt at it, with each attempt kept as its history', () => {
    const replaced = { ...interrupted, replacedByAttempt: 2 };
    const replacement = attemptWith({ attempt: 2, task: 'pid-2', startedAt: at(75) });

    const [slice, ...others] = slicesOf([replaced, replacement], sourcesWith());

    expect(others).toEqual([]);
    expect(slice).toMatchObject({
      generator: 0,
      firstUser: 0,
      userCount: 10,
      startedAt: at(1),
      endedAt: at(170),
      hold: null,
    });
    expect(slice?.attempts.map(({ attempt, task }) => [attempt, task])).toEqual([
      [1, 'pid-1'],
      [2, 'pid-2'],
    ]);
  });

  it('holds from when the first generator began holding, to the end of its plan', () => {
    const planned = attemptWith({ planned: { rampEndsAt: at(10), holdEndsAt: at(150) } });
    const reported = sourcesWith({ reportOf: () => reportWith([1, 12], [12, 150]) });

    expect(slicesOf([planned], sourcesWith())[0]?.hold).toEqual({ from: at(10), to: at(150) });
    expect(slicesOf([planned], reported)[0]?.hold).toEqual({ from: at(12), to: at(150) });
  });

  it('ends when its last generator was told to stop, else when it stopped', () => {
    const told = attemptWith({ toldToStopAt: at(160) });

    expect(slicesOf([told], sourcesWith())[0]?.endedAt).toBe(at(160));
    expect(slicesOf([attemptWith({ stoppedAt: null })], sourcesWith())[0]?.endedAt).toBeNull();
  });

  describe('a generator that stopped early', () => {
    it('leaves its slice down from its stop to the end of its planned hold', () => {
      const planned = { ...interrupted, planned: { rampEndsAt: at(10), holdEndsAt: at(150) } };

      expect(downOf([planned])).toEqual([
        {
          from: at(60),
          to: at(150),
          reason: 'its generator stopped (interrupted: reclaimed); no generator took its place',
        },
      ]);
    });

    it('leaves it down only until its replacement started, when the replacement had no ramp to bring users back over', () => {
      const replaced = { ...interrupted, replacedByAttempt: 2 };
      const replacement = attemptWith({ attempt: 2, startedAt: at(75) });

      expect(downOf([replaced, replacement])).toEqual([
        {
          from: at(60),
          to: at(75),
          reason:
            'its generator stopped (interrupted: reclaimed); a new generator brought the users back',
        },
      ]);
    });

    describe('with a replacement that brought its users back over a ramp', () => {
      const replaced = { ...interrupted, replacedByAttempt: 2 };
      const replacement = attemptWith({
        attempt: 2,
        startedAt: at(62),
        planned: { rampEndsAt: at(122), holdEndsAt: at(170) },
      });

      it('leaves it down until the ramp ended, as it ran', () => {
        const reported = sourcesWith({
          reportOf: (_, attempt) => (attempt === 2 ? reportWith([62, 125], [125, 170]) : null),
        });

        expect(downOf([replaced, replacement], reported)).toEqual([
          {
            from: at(60),
            to: at(125),
            reason:
              'its generator stopped (interrupted: reclaimed); a new generator brought the users back',
          },
        ]);
      });

      it('leaves it down until the ramp was due to end when the replacement never reported', () => {
        expect(downOf([replaced, replacement])).toMatchObject([{ from: at(60), to: at(122) }]);
      });
    });

    it('joins the windows of a replacement lost before it brought the users back into one', () => {
      const first = { ...interrupted, replacedByAttempt: 2 };
      const second = attemptWith({
        attempt: 2,
        startedAt: at(62),
        stoppedAt: at(90),
        stoppedBecause: 'failed',
        replacedByAttempt: 3,
        planned: { rampEndsAt: at(122), holdEndsAt: at(170) },
      });
      const third = attemptWith({ attempt: 3, startedAt: at(92) });

      expect(downOf([first, second, third])).toEqual([
        {
          from: at(60),
          to: at(122),
          reason:
            'its generator stopped (interrupted: reclaimed); a new generator brought the users back; then its generator stopped (failed); a new generator brought the users back',
        },
      ]);
    });

    it('keeps two windows apart when the slice was back between them', () => {
      const first = { ...interrupted, replacedByAttempt: 2 };
      const second = attemptWith({
        attempt: 2,
        startedAt: at(75),
        stoppedAt: at(120),
        stoppedBecause: 'failed',
        replacedByAttempt: 3,
      });
      const third = attemptWith({ attempt: 3, startedAt: at(130) });

      expect(downOf([first, second, third]).map(({ from, to }) => [from, to])).toEqual([
        [at(60), at(75)],
        [at(120), at(130)],
      ]);
    });

    it('leaves it down to the end of the run when nothing says when it was due to end', () => {
      expect(downOf([interrupted])).toMatchObject([{ from: at(60), to: at(180) }]);
    });

    it('does not leave it down when it finished, or when the guard stopped it', () => {
      const guarded = attemptWith({ generator: 1, stoppedBecause: 'guard' });

      expect(downOf([attemptWith(), guarded])).toEqual([]);
    });

    it('takes it down when the generator was told to stop, not when its task had been torn down', () => {
      const told = { ...interrupted, toldToStopAt: at(25) };

      expect(downOf([told])).toMatchObject([{ from: at(25), to: at(180) }]);
    });

    it('takes it down at its last state line when the record does not say when it was told to stop', () => {
      const states = sourcesWith({ lastStateAt: () => at(28) });

      expect(downOf([interrupted], states)).toMatchObject([{ from: at(28) }]);
    });

    it('does not leave it down when the end of the run stopped it', () => {
      const ended = { ...interrupted, toldToStopAt: at(25), stoppedForRunEnd: true };

      expect(downOf([ended])).toEqual([]);
    });

    it('never leaves it down past the end of the run, though its plan went on', () => {
      const planned = { ...interrupted, planned: { rampEndsAt: at(10), holdEndsAt: at(900) } };

      expect(downOf([planned])).toMatchObject([{ from: at(60), to: at(180) }]);
    });

    it('takes it down at its last state line when no stop was recorded for it', () => {
      const unrecorded = attemptWith({ stoppedAt: null, stoppedBecause: null });
      const states = sourcesWith({ lastStateAt: () => at(44) });

      expect(downOf([unrecorded], states)).toMatchObject([
        { from: at(44), reason: 'its generator has no recorded stop; no generator took its place' },
      ]);
    });
  });
});

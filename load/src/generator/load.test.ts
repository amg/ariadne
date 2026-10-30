import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLevels } from './levels.ts';
import type { Plan } from './plan.ts';
import { createRequestLog } from './requestLog.ts';

vi.mock('./virtualUser.ts', () => ({ runUser: vi.fn(), seedUser: vi.fn() }));

const { runUser } = await import('./virtualUser.ts');
const { runLoad } = await import('./load.ts');

const plan: Plan = {
  mode: 'load',
  runId: 'run-1',
  generator: 2,
  attempt: 1,
  targetUrl: 'http://app.test',
  loadKeyHeader: 'x-load-key',
  loadKey: 'key',
  password: 'secret',
  emailDomain: 'load.invalid',
  firstUser: 10,
  userCount: 4,
  chattingShare: 1,
  rampSeconds: 4,
  holdSeconds: 30,
  endsAt: null,
  thinkSeconds: 5,
  seedConcurrency: 1,
  stateSeconds: 5,
  publishMetrics: false,
  direct: null,
};

const requests = () =>
  createRequestLog({ who: { run: 'run-1', generator: 2, attempt: 1 }, emit: () => undefined });

/** A user that holds until it is told to stop, then takes `stoppingMs` to do so. */
function userStoppingIn(stoppingMs: number) {
  vi.mocked(runUser).mockImplementation(
    ({ signal }) =>
      new Promise((resolve) =>
        signal.addEventListener('abort', () =>
          stoppingMs === 0 ? resolve() : setTimeout(resolve, stoppingMs),
        ),
      ),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  userStoppingIn(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('runLoad', () => {
  it('brings its users up over the ramp, holds them, and reports when each stretch ran', async () => {
    const interrupt = new AbortController();
    const running = runLoad({
      plan,
      levels: createLevels(),
      requests: requests(),
      interrupt: interrupt.signal,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(runUser).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(runUser).toHaveBeenCalledTimes(4);
    expect(vi.mocked(runUser).mock.calls.map(([{ userNumber }]) => userNumber)).toEqual([
      10, 11, 12, 13,
    ]);
    await vi.advanceTimersByTimeAsync(31_000);

    const result = await running;
    expect(result.interrupted).toBe(false);
    expect(result.phases).not.toBeNull();
  });

  it('ends its ramp on time when the generator stalls during it, starting the late users at once', async () => {
    const stalledUser = 11;
    vi.mocked(runUser).mockImplementation(({ userNumber, signal }) => {
      // The clock jumps as it would while the generator is too busy to run timers.
      if (userNumber === stalledUser) vi.setSystemTime(Date.now() + 2_000);
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve()));
    });
    const startedAt = Date.now();
    const running = runLoad({
      plan,
      levels: createLevels(),
      requests: requests(),
      interrupt: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(40_000);

    const { phases } = await running;

    expect(phases.ramp.endedAt).toBe(new Date(startedAt + 4_000).toISOString());
  });

  it('stops its users and gives up the plan at once when told to stop mid-hold', async () => {
    const interrupt = new AbortController();
    const running = runLoad({
      plan,
      levels: createLevels(),
      requests: requests(),
      interrupt: interrupt.signal,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    interrupt.abort();
    const result = await running;

    expect(result.interrupted).toBe(true);
    expect(runUser).toHaveBeenCalledTimes(4);
  });

  it('reports the phases it ran when told to stop mid-hold, the hold ending at the stop', async () => {
    const interrupt = new AbortController();
    const startedAt = Date.now();
    const running = runLoad({
      plan,
      levels: createLevels(),
      requests: requests(),
      interrupt: interrupt.signal,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    interrupt.abort();
    const { phases } = await running;

    const at = (secondsIn: number) => new Date(startedAt + secondsIn * 1_000).toISOString();
    expect(phases).toEqual({
      ramp: { startedAt: at(0), endedAt: at(4) },
      hold: { startedAt: at(4), endedAt: at(10) },
      rampDown: { startedAt: at(10), endedAt: at(10) },
    });
  });

  it('reports a ramp that ended when it was told to stop, and no hold, when told to stop mid-ramp', async () => {
    const interrupt = new AbortController();
    const startedAt = Date.now();
    const running = runLoad({
      plan,
      levels: createLevels(),
      requests: requests(),
      interrupt: interrupt.signal,
    });
    await vi.advanceTimersByTimeAsync(1_500);

    interrupt.abort();
    const { phases } = await running;

    const stoppedAt = new Date(startedAt + 1_500).toISOString();
    expect(phases.ramp).toEqual({
      startedAt: new Date(startedAt).toISOString(),
      endedAt: stoppedAt,
    });
    expect(phases.hold).toEqual({ startedAt: stoppedAt, endedAt: stoppedAt });
  });

  it('starts no more users when told to stop mid-ramp', async () => {
    const interrupt = new AbortController();
    const running = runLoad({
      plan,
      levels: createLevels(),
      requests: requests(),
      interrupt: interrupt.signal,
    });
    await vi.advanceTimersByTimeAsync(1_500);

    interrupt.abort();
    const result = await running;

    expect(result.interrupted).toBe(true);
    expect(runUser).toHaveBeenCalledTimes(2);
  });

  it('reports without waiting for users that will not stop inside the time it was given', async () => {
    userStoppingIn(10 * 60_000);
    const interrupt = new AbortController();
    const running = runLoad({
      plan,
      levels: createLevels(),
      requests: requests(),
      interrupt: interrupt.signal,
      stopWithinMs: 90_000,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    interrupt.abort();
    await vi.advanceTimersByTimeAsync(90_000);

    expect((await running).interrupted).toBe(true);
  });
});

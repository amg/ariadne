import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLevels } from './levels.ts';
import type { Plan } from './plan.ts';

const { signIn, holdPush } = vi.hoisted(() => ({ signIn: vi.fn(), holdPush: vi.fn() }));

vi.mock('./api.ts', () => ({
  createUserClient: () => ({ signIn, signUp: vi.fn() }),
}));

const { runUser } = await import('./virtualUser.ts');

const requests = { record: () => undefined };

/** A signed-in user whose push stream stays open until the run stops. */
const user = { createThread: vi.fn(), sendChat: vi.fn(), continuePaused: vi.fn(), holdPush };

const plan: Plan = {
  mode: 'load',
  runId: 'run-1',
  generator: 0,
  attempt: 1,
  targetUrl: 'http://app.test',
  loadKeyHeader: 'x-load-key',
  loadKey: 'key',
  password: 'secret',
  emailDomain: 'load.invalid',
  firstUser: 0,
  userCount: 1,
  chattingShare: 0,
  rampSeconds: 0,
  holdSeconds: 0,
  endsAt: null,
  thinkSeconds: 30,
  seedConcurrency: 1,
  stateSeconds: 5,
  publishMetrics: false,
  direct: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('runUser sign-in', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  /** A run that stops when told to: its push stream stays open until then. */
  function stoppingRun() {
    const stop = new AbortController();
    holdPush.mockImplementation(
      () => new Promise<void>((resolve) => stop.signal.addEventListener('abort', () => resolve())),
    );
    return stop;
  }

  it('tries again after a growing pause until sign-in works', async () => {
    signIn
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(user);
    const levels = createLevels();
    const stop = stoppingRun();
    const running = runUser({ plan, userNumber: 0, levels, requests, signal: stop.signal });

    await vi.advanceTimersByTimeAsync(0);
    expect(signIn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(signIn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(signIn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(signIn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(signIn).toHaveBeenCalledTimes(3);
    expect(levels.now()).toMatchObject({ usersSignedIn: 1, pushStreamsOpen: 1 });

    stop.abort();
    await running;
    expect(levels.now()).toMatchObject({ usersSignedIn: 0, pushStreamsOpen: 0 });
  });

  it('gives up on sign-in when the run stops first', async () => {
    signIn.mockRejectedValue(new Error('down'));
    const levels = createLevels();
    const stop = stoppingRun();
    const running = runUser({ plan, userNumber: 0, levels, requests, signal: stop.signal });

    await vi.advanceTimersByTimeAsync(0);
    stop.abort();
    await running;
    expect(levels.now()).toEqual({ usersSignedIn: 0, pushStreamsOpen: 0, chattersActive: 0 });
    expect(holdPush).not.toHaveBeenCalled();
  });
});

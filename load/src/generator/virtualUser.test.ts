import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLevels } from './levels.ts';
import type { Plan } from './plan.ts';
import type { Session } from './session.ts';

vi.mock('./api.ts', () => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  createThread: vi.fn(),
  sendChat: vi.fn(),
  continuePaused: vi.fn(),
  holdPush: vi.fn(),
}));

const { signIn, holdPush } = await import('./api.ts');
const { runUser } = await import('./virtualUser.ts');

const requests = { record: () => undefined };

const session: Session = {
  headers: () => ({}),
  canRefresh: () => true,
  refreshAfterRejection: async () => undefined,
};

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
    vi.mocked(holdPush).mockImplementation(
      (_plan, _session, signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve())),
    );
  });

  it('tries again after a growing pause until sign-in works', async () => {
    vi.mocked(signIn)
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(session);
    const levels = createLevels();
    const stop = new AbortController();
    const user = runUser(plan, 0, levels, requests, stop.signal);

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
    await user;
    expect(levels.now()).toMatchObject({ usersSignedIn: 0, pushStreamsOpen: 0 });
  });

  it('gives up on sign-in when the run stops first', async () => {
    vi.mocked(signIn).mockRejectedValue(new Error('down'));
    const levels = createLevels();
    const stop = new AbortController();
    const user = runUser(plan, 0, levels, requests, stop.signal);

    await vi.advanceTimersByTimeAsync(0);
    stop.abort();
    await user;
    expect(levels.now()).toEqual({ usersSignedIn: 0, pushStreamsOpen: 0, chattersActive: 0 });
    expect(holdPush).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECONNECT_SPREAD_SECONDS, backoffSeconds, pause } from './retry.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('backoffSeconds', () => {
  it('spreads the return of users whose stream dropped over the reconnect spread, none at one moment', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffSeconds(0)).toBe(0);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(backoffSeconds(0)).toBe(RECONNECT_SPREAD_SECONDS / 2);
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(backoffSeconds(0)).toBeLessThan(RECONNECT_SPREAD_SECONDS);
  });

  it('returns users at different moments', () => {
    const waits = new Set(Array.from({ length: 50 }, () => backoffSeconds(0)));
    expect(waits.size).toBeGreaterThan(40);
  });

  it('doubles the ceiling with each failure in a row, and spreads each wait over its upper half', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([0.5, 1, 2, 4]);
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect([1, 2, 3, 4].map(backoffSeconds).map(Math.ceil)).toEqual([1, 2, 4, 8]);
  });

  it('never waits longer than a minute', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(backoffSeconds(50)).toBeLessThanOrEqual(60);
    expect(backoffSeconds(50)).toBeGreaterThan(59);
  });
});

describe('pause', () => {
  beforeEach(() => vi.useFakeTimers());

  it('resolves after the time given', async () => {
    const done = vi.fn();
    pause(2, new AbortController().signal).then(done);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
  });

  it('resolves at once when the signal aborts', async () => {
    const stop = new AbortController();
    const done = vi.fn();
    pause(60, stop.signal).then(done);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalled();
  });

  it('leaves no listener on the signal once it has resolved', async () => {
    const stop = new AbortController();
    const removed = vi.spyOn(stop.signal, 'removeEventListener');
    const added = vi.spyOn(stop.signal, 'addEventListener');
    for (let i = 0; i < 3; i += 1) {
      const paused = pause(1, stop.signal);
      await vi.advanceTimersByTimeAsync(1_000);
      await paused;
    }
    expect(added).toHaveBeenCalledTimes(3);
    expect(removed).toHaveBeenCalledTimes(3);
  });
});

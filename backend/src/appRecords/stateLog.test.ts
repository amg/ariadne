import { useAppRecordCapture } from '@test/appRecords';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyName } from './copyName';
import { STATE_MEASURE_TIMEOUT_MS, keepLoggingState } from './stateLog';

const capture = useAppRecordCapture();

const STATE_EVERY_MS = 20_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('STATE_LOG_INTERVAL_SECONDS', String(STATE_EVERY_MS / 1_000));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('the state record', () => {
  it('is written at once and then at the configured interval, with what the copy measures', async () => {
    let streams = 3;
    const stop = keepLoggingState({
      pushStreamsOpen: () => streams,
      oldestJobWaitMs: async () => 250,
    });

    await vi.advanceTimersByTimeAsync(0);
    streams = 5;
    await vi.advanceTimersByTimeAsync(STATE_EVERY_MS);
    stop();
    await vi.advanceTimersByTimeAsync(STATE_EVERY_MS * 2);

    const lines = capture.written('state');
    expect(lines).toMatchObject([
      { copy: copyName(), pushStreamsOpen: 3, oldestJobWaitMs: 250 },
      { copy: copyName(), pushStreamsOpen: 5, oldestJobWaitMs: 250 },
    ]);
    expect(lines[0]?.at).toMatch(/^\d{4}-\d\d-\d\dT[\d:]+\.\d{3}Z$/);
  });

  it('carries what the copy says of how loaded it is', async () => {
    const stop = keepLoggingState({
      eventLoopDelayP99Ms: () => 12.5,
      memory: () => ({ heapUsedBytes: 100, residentBytes: 300 }),
      databaseConnections: () => ({ inUse: 7, waiting: 2 }),
      workerSlots: () => ({ busy: 16, total: 16 }),
      pushBusFailures: () => 3,
    });
    await vi.advanceTimersByTimeAsync(0);
    stop();

    expect(capture.written('state')).toMatchObject([
      {
        eventLoopDelayP99Ms: 12.5,
        heapUsedBytes: 100,
        residentBytes: 300,
        dbConnectionsInUse: 7,
        dbConnectionsWaiting: 2,
        workerSlotsBusy: 16,
        workerSlots: 16,
        pushBusFailures: 3,
      },
    ]);
  });

  it('asks a measure that counts since it was last asked once for each line written', async () => {
    let asked = 0;
    const stop = keepLoggingState({
      pushBusFailures: () => {
        asked += 1;
        return asked;
      },
    });
    await vi.advanceTimersByTimeAsync(STATE_EVERY_MS);
    stop();

    expect(capture.written('state').map((line) => line.pushBusFailures)).toEqual([1, 2]);
  });

  it('leaves a figure null when its measure fails, and writes the rest', async () => {
    const stop = keepLoggingState({
      pushStreamsOpen: () => 4,
      memory: () => {
        throw new Error('no reading');
      },
      databaseConnections: () => ({ inUse: 1, waiting: 0 }),
    });
    await vi.advanceTimersByTimeAsync(0);
    stop();

    expect(capture.written('state')).toMatchObject([
      { pushStreamsOpen: 4, heapUsedBytes: null, residentBytes: null, dbConnectionsInUse: 1 },
    ]);
  });

  it('leaves a measure the copy does not take as null', async () => {
    const stop = keepLoggingState({ pushStreamsOpen: () => 7 });
    await vi.advanceTimersByTimeAsync(0);
    stop();

    expect(capture.written('state')).toMatchObject([
      {
        pushStreamsOpen: 7,
        oldestJobWaitMs: null,
        eventLoopDelayP99Ms: null,
        heapUsedBytes: null,
        dbConnectionsInUse: null,
        workerSlotsBusy: null,
        pushBusFailures: null,
      },
    ]);
  });

  it('survives a measure that fails, leaving it null for that line', async () => {
    const stop = keepLoggingState({
      oldestJobWaitMs: async () => {
        throw new Error('database down');
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    stop();

    expect(capture.written('state')).toMatchObject([
      { pushStreamsOpen: null, oldestJobWaitMs: null },
    ]);
  });

  it('keeps logging after a measure that throws before it returns a promise', async () => {
    let calls = 0;
    const stop = keepLoggingState({
      oldestJobWaitMs: () => {
        calls += 1;
        throw new Error('no pool');
      },
    });
    await vi.advanceTimersByTimeAsync(STATE_EVERY_MS);
    stop();

    expect(calls).toBe(2);
    expect(capture.written('state')).toHaveLength(2);
  });

  it('gives a measure its time limit', async () => {
    const limits: number[] = [];
    const stop = keepLoggingState({
      oldestJobWaitMs: async ({ timeoutMs }) => {
        limits.push(timeoutMs);
        return 0;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    stop();

    expect(limits).toEqual([STATE_MEASURE_TIMEOUT_MS]);
  });

  it('writes the line without a measure that runs past its limit, and starts no other while it runs', async () => {
    let started = 0;
    let finish: (waited: number) => void = () => undefined;
    const stop = keepLoggingState({
      pushStreamsOpen: () => 1,
      oldestJobWaitMs: () => {
        started += 1;
        if (started > 1) return Promise.resolve(40);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });

    await vi.advanceTimersByTimeAsync(STATE_EVERY_MS * 3);
    expect(started).toBe(1);
    expect(capture.written('state')).toMatchObject([{ pushStreamsOpen: 1, oldestJobWaitMs: null }]);

    finish(40);
    await vi.advanceTimersByTimeAsync(STATE_EVERY_MS);
    stop();

    expect(started).toBe(2);
    expect(capture.written('state')).toHaveLength(2);
  });

  it('writes the figures it can read at once when a slow measure runs past its limit, and keeps the counts of a record it skips', async () => {
    let asked = 0;
    const stop = keepLoggingState({
      memory: () => ({ heapUsedBytes: 5, residentBytes: 9 }),
      pushBusFailures: () => {
        asked += 1;
        return asked;
      },
      oldestJobWaitMs: () => new Promise(() => undefined),
    });

    await vi.advanceTimersByTimeAsync(STATE_EVERY_MS * 3);
    stop();

    // The first record waited out the limit and was written without the job wait. The ticks
    // while that measure was still running wrote nothing and asked nothing.
    expect(capture.written('state')).toMatchObject([
      { heapUsedBytes: 5, residentBytes: 9, pushBusFailures: 1, oldestJobWaitMs: null },
    ]);
    expect(asked).toBe(1);
  });

  it('writes nothing more once stopped, even for a measure still running', async () => {
    let finish: (waited: number) => void = () => undefined;
    const stop = keepLoggingState({
      oldestJobWaitMs: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await vi.advanceTimersByTimeAsync(STATE_MEASURE_TIMEOUT_MS / 2);

    stop();
    finish(10);
    await vi.advanceTimersByTimeAsync(STATE_EVERY_MS * 2);

    expect(capture.written('state')).toEqual([]);
  });
});

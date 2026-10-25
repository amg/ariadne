import { describe, expect, it } from 'vitest';
import {
  appRequestWith,
  appStateWith,
  at,
  exchangeWith,
  requestWith,
  runDataWith,
  sliceDataWith,
  sliceWith,
} from '../runData/testing.ts';
import { summarize } from './summary.ts';

const withRequests = (...lines: ReturnType<typeof requestWith>[]) =>
  runDataWith({ slices: [sliceDataWith(sliceWith(), { requests: lines })] });

describe('summarize', () => {
  it('counts each kind by outcome and gives exact percentiles of the requests served', () => {
    const lines = [
      ...Array.from({ length: 100 }, (_, index) =>
        requestWith({ firstByteMs: index + 1, totalMs: (index + 1) * 2 }),
      ),
      requestWith({ outcome: 'paused', firstByteMs: 99_999 }),
      requestWith({ outcome: 'failed', status: null, errorCode: 'unreachable' }),
    ];

    const { requests } = summarize(withRequests(...lines));

    expect(requests.total).toBe(102);
    expect(requests.byKind.chat).toMatchObject({
      count: 102,
      byOutcome: { failed: 1, paused: 1, streamed: 100 },
      firstByteMs: { count: 100, p50: 50, p95: 95, p99: 99, max: 100 },
      totalMs: { count: 100, p50: 100, p95: 190, p99: 198, max: 200 },
    });
    expect(requests.failures).toEqual([
      { kind: 'chat', status: null, errorCode: 'unreachable', count: 1 },
    ]);
  });

  it('adds up what the generators held at once, and counts none that has stopped', () => {
    const first = sliceWith({ generator: 0, endedAt: at(100) });
    const second = sliceWith({ generator: 1, startedAt: at(12) });
    const later = sliceWith({ generator: 2, startedAt: at(110), endedAt: at(170) });
    const state = (generatorNumber: number, seconds: number, users: number) => ({
      run: 'run-1',
      generator: generatorNumber,
      attempt: 1,
      at: at(seconds),
      usersSignedIn: users,
      pushStreamsOpen: users,
      chattersActive: users / 2,
    });
    const data = runDataWith({
      slices: [
        sliceDataWith(first, { states: [state(0, 10, 4), state(0, 20, 6), state(0, 80, 2)] }),
        sliceDataWith(second, { states: [state(1, 15, 8)] }),
        sliceDataWith(later, { states: [state(2, 130, 20)] }),
      ],
    });

    // At 20 s the first holds 6 and the second's line of 5 s before holds 8. The first has
    // stopped by 130 s, and the second's line is too old to say anything then.
    expect(summarize(data).users).toEqual({
      peakSignedIn: 20,
      peakPushStreams: 20,
      peakChatters: 10,
    });
  });

  it('adds the generators of one moment together', () => {
    const state = (generatorNumber: number, seconds: number, users: number) => ({
      run: 'run-1',
      generator: generatorNumber,
      attempt: 1,
      at: at(seconds),
      usersSignedIn: users,
      pushStreamsOpen: users,
      chattersActive: users,
    });
    const data = runDataWith({
      slices: [
        sliceDataWith(sliceWith({ generator: 0 }), { states: [state(0, 10, 4), state(0, 20, 6)] }),
        sliceDataWith(sliceWith({ generator: 1 }), { states: [state(1, 15, 8)] }),
      ],
    });

    expect(summarize(data).users.peakSignedIn).toBe(14);
  });

  it('tells a replayed verdict apart, and times only the verdicts the gate judged', () => {
    const { app } = summarize(
      runDataWith({
        exchanges: [
          exchangeWith({ verdict: 'pass', verdictAfterMs: 300 }),
          exchangeWith({
            trigger: 'retry',
            verdict: 'pass',
            verdictReplayed: true,
            verdictAfterMs: 1,
          }),
        ],
      }),
    );

    expect(app.exchanges?.byVerdict).toEqual({ pass: 1, replayed: 1 });
    expect(app.exchanges?.verdictMs).toMatchObject({ count: 1, max: 300 });
  });

  it('leaves out what a missing source would have said', () => {
    const { app } = summarize(
      runDataWith({ exchanges: null, jobs: null, appRequests: null, appStates: null }),
    );
    expect(app).toMatchObject({
      exchanges: null,
      jobs: null,
      requests: null,
      peakPushStreams: null,
      longestJobWaitMs: null,
    });
    expect(Object.values(app.copies)).toEqual(Array(8).fill(null));
  });

  it('gives the API’s server time by route, with the server errors of each, and names a request no route took', () => {
    const { app } = summarize(
      runDataWith({
        appRequests: [
          appRequestWith({ route: '/api/a', durationMs: 100 }),
          appRequestWith({ route: '/api/a', durationMs: 300, statusCode: 503 }),
          appRequestWith({ route: '/api/b', durationMs: 5 }),
          appRequestWith({ route: null, statusCode: 404, durationMs: 1 }),
        ],
      }),
    );

    expect(app.requests).toMatchObject({
      count: 4,
      byRoute: {
        '/api/a': { count: 2, serverErrors: 1, serverMs: { p50: 100, max: 300 } },
        '/api/b': { count: 1, serverErrors: 0 },
        'no route': { count: 1, serverErrors: 0 },
      },
    });
  });

  it('gives the worst of what the copies said of how loaded they were, and adds up the push bus failures', () => {
    const { app } = summarize(
      runDataWith({
        appStates: [
          appStateWith({
            eventLoopDelayP99Ms: 20,
            heapUsedBytes: 100,
            residentBytes: 400,
            dbConnectionsInUse: 5,
            dbConnectionsWaiting: 0,
            workerSlotsBusy: 3,
            workerSlots: 16,
            pushBusFailures: 1,
          }),
          appStateWith({
            copy: 'api-2',
            eventLoopDelayP99Ms: 90,
            heapUsedBytes: 80,
            residentBytes: 500,
            dbConnectionsInUse: 10,
            dbConnectionsWaiting: 4,
            workerSlotsBusy: null,
            pushBusFailures: 2,
          }),
          appStateWith({ copy: 'old-copy' }),
        ],
      }),
    );

    expect(app.copies).toEqual({
      longestEventLoopDelayMs: 90,
      peakHeapUsedBytes: 100,
      peakResidentBytes: 500,
      peakDbConnectionsInUse: 10,
      peakDbConnectionsWaiting: 4,
      peakWorkerSlotsBusy: 3,
      workerSlots: 16,
      pushBusFailures: 3,
    });
  });
});

describe('summarize, copy by copy', () => {
  it('gives the worst of each figure each copy gave, by the copy’s label', () => {
    const summary = summarize(
      runDataWith({
        appStates: [
          appStateWith({ copy: '1867eeaa9f', pushStreamsOpen: 9_358, dbConnectionsWaiting: 159 }),
          appStateWith({ copy: '1867eeaa9f', at: at(20), pushStreamsOpen: 9_000 }),
          appStateWith({ copy: 'a0145435c1', workerSlots: 16, eventLoopDelayP99Ms: 255 }),
        ],
      }),
    );

    expect(summary.app.byCopy['api-1867eeaa']).toMatchObject({
      copy: '1867eeaa9f',
      peakPushStreams: 9_358,
      peakDbConnectionsWaiting: 159,
    });
    expect(summary.app.byCopy['worker-a0145435']).toMatchObject({
      longestEventLoopDelayMs: 255,
      workerSlots: 16,
      peakPushStreams: null,
    });
  });
});

describe('summarize, push streams', () => {
  const push = (user: number, seconds: number, outcome: 'failed' | 'held') =>
    requestWith({
      kind: 'push',
      user,
      startedAt: at(seconds),
      totalMs: 50_000,
      status: 200,
      outcome,
    });

  it('counts the streams that opened, those that ended early, and those reopened', () => {
    const summary = summarize(
      runDataWith({
        slices: [
          sliceDataWith(sliceWith(), {
            requests: [push(0, 0, 'failed'), push(0, 52, 'held'), push(1, 0, 'failed')],
          }),
        ],
      }),
    );

    expect(summary.pushStreams).toEqual({
      opened: 3,
      endedEarly: 2,
      cut: 2,
      reopened: 1,
      reopenedWithinSeconds: 10,
      mostEndedInAMinute: { minute: at(0), count: 2 },
    });
  });
});

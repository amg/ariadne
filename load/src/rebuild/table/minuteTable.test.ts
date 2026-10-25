import { describe, expect, it } from 'vitest';
import { MINUTE_MS } from '../moments.ts';
import {
  STARTED,
  appRequestWith,
  appStateWith,
  at,
  exchangeWith,
  requestWith,
  runDataWith,
  sliceDataWith,
  sliceWith,
} from '../runData/testing.ts';
import { ANSWERED_BY_END, SLICES_DOWN } from './columns/runColumns.ts';
import { minuteTable, valuesOf } from './minuteTable.ts';

const MINUTE_0 = Date.parse(STARTED);
const slice = sliceWith();
const slicesOf = (...requests: ReturnType<typeof requestWith>[]) => [
  sliceDataWith(slice, { requests }),
];

/** The figures of one series, one for each minute of the run; the run lasts three minutes, so four minutes are drawn. */
const figures = (data: ReturnType<typeof runDataWith>, name: string) =>
  valuesOf(minuteTable(data), name);

describe('minuteTable', () => {
  it('has one figure for each minute of the run, from its start to the minute it ended in', () => {
    const series = minuteTable(runDataWith());

    expect(series.minutes).toEqual([0, 1, 2, 3].map((index) => MINUTE_0 + index * MINUTE_MS));
    expect(series.afterRunFrom).toBeNull();
  });

  it('leaves out a series with no figure in any minute, but not the slices down, and gives null for one it does not have', () => {
    const series = minuteTable(runDataWith({ exchanges: null, jobs: null, appRequests: null }));

    // Only the count of slices down is a figure on its own: nothing down is a zero.
    expect(series.columns.map(({ name }) => name)).toEqual([SLICES_DOWN]);
    expect(valuesOf(series, 'requests')).toEqual([null, null, null, null]);
  });

  it('counts requests, failures and the share that failed in the minute each began in', () => {
    const data = runDataWith({
      slices: slicesOf(
        requestWith({ startedAt: at(10) }),
        requestWith({ startedAt: at(20), outcome: 'failed', status: 503 }),
        requestWith({ startedAt: at(70), kind: 'signin', outcome: 'failed', status: 500 }),
        requestWith({ startedAt: at(80), kind: 'signin', outcome: 'ok', status: 200 }),
        requestWith({ startedAt: at(90), kind: 'signin', outcome: 'ok', status: 200 }),
        requestWith({ startedAt: at(100), kind: 'signin', outcome: 'ok', status: 200 }),
      ),
    });

    expect(figures(data, 'requests')).toEqual([2, 4, 0, 0]);
    expect(figures(data, 'failures')).toEqual([1, 1, 0, 0]);
    expect(figures(data, 'failed_percent')).toEqual([50, 25, null, null]);
    expect(figures(data, 'signin_failures_percent')).toEqual([null, 25, null, null]);
    expect(figures(data, 'failures_signin')).toEqual([0, 1, 0, 0]);
  });

  it('gives the chat first byte percentiles of the replies that streamed in each minute', () => {
    const streamed = (seconds: number, firstByteMs: number) =>
      requestWith({ startedAt: at(seconds), firstByteMs });
    const data = runDataWith({
      slices: slicesOf(
        ...[100, 200, 300, 400].map((ms, index) => streamed(10 + index, ms)),
        requestWith({ startedAt: at(15), outcome: 'paused', firstByteMs: 9_000 }),
      ),
    });

    expect(figures(data, 'chat_first_byte_p50_ms')[0]).toBe(200);
    expect(figures(data, 'chat_first_byte_p95_ms')[0]).toBe(400);
    expect(figures(data, 'chat_first_byte_p95_ms')[1]).toBeNull();
  });

  it('gives the gate’s waits at the limit as a share of the verdicts it judged, minute by minute', () => {
    const data = runDataWith({
      exchanges: [
        exchangeWith({ arrivedAt: at(10), verdict: 'pass' }),
        exchangeWith({ arrivedAt: at(20), verdict: 'pass' }),
        exchangeWith({ arrivedAt: at(30), verdict: 'pending', outcome: 'gate-pending' }),
        exchangeWith({ arrivedAt: at(40), verdict: 'pass', verdictReplayed: true }),
        exchangeWith({ arrivedAt: at(70), verdict: 'pass' }),
      ],
    });

    expect(figures(data, 'gate_waits_at_limit_percent')).toEqual([33.33, 0, null, null]);
  });

  it('rounds a figure to a tenth unless the figure needs more places', () => {
    const data = runDataWith({
      slices: slicesOf(
        requestWith({ startedAt: at(10), kind: 'signin', outcome: 'failed', status: 500 }),
        ...[1, 2].map((second) =>
          requestWith({ startedAt: at(10 + second), kind: 'signin', outcome: 'ok' }),
        ),
      ),
    });

    expect(figures(data, 'signin_failures_percent')[0]).toBe(33.33);
  });

  it('counts the answers by the minute they ended in, as the load balancer does, with how many were errors', () => {
    const data = runDataWith({
      slices: slicesOf(
        requestWith({ startedAt: at(50), totalMs: 30_000, status: 200 }),
        requestWith({ startedAt: at(70), totalMs: 100, status: 503, outcome: 'failed' }),
        requestWith({ startedAt: at(75), totalMs: 100, status: 429, outcome: 'failed' }),
        requestWith({ startedAt: at(80), totalMs: 100, status: null, outcome: 'failed' }),
      ),
    });

    expect(figures(data, ANSWERED_BY_END.all)).toEqual([0, 3, 0, 0]);
    expect(figures(data, ANSWERED_BY_END.serverErrors)).toEqual([0, 1, 0, 0]);
    expect(figures(data, ANSWERED_BY_END.clientErrors)).toEqual([0, 1, 0, 0]);
  });

  it('gives the worst each copy said of how loaded it was in each minute, in mebibytes for memory, and adds up the push bus failures', () => {
    const series = minuteTable(
      runDataWith({
        appStates: [
          appStateWith({
            at: at(10),
            eventLoopDelayP99Ms: 20,
            heapUsedBytes: 104_857_600,
            residentBytes: 314_572_800,
            dbConnectionsInUse: 5,
            dbConnectionsWaiting: 0,
            workerSlotsBusy: 2,
            workerSlots: 16,
            pushBusFailures: 1,
          }),
          appStateWith({
            at: at(20),
            eventLoopDelayP99Ms: 70,
            dbConnectionsInUse: 9,
            dbConnectionsWaiting: 3,
            workerSlotsBusy: 4,
            pushBusFailures: 2,
          }),
          appStateWith({ at: at(70), eventLoopDelayP99Ms: 5, pushBusFailures: 0 }),
        ],
      }),
    );

    expect(valuesOf(series, 'app_event_loop_delay_p99_max_ms').slice(0, 2)).toEqual([70, 5]);
    expect(valuesOf(series, 'app_heap_used_max_mib').slice(0, 2)).toEqual([100, null]);
    expect(valuesOf(series, 'app_resident_max_mib').slice(0, 2)).toEqual([300, null]);
    expect(valuesOf(series, 'app_db_connections_in_use_max').slice(0, 2)).toEqual([9, null]);
    expect(valuesOf(series, 'app_db_connections_waiting_max').slice(0, 2)).toEqual([3, null]);
    expect(valuesOf(series, 'app_worker_slots_busy_max').slice(0, 2)).toEqual([4, null]);
    expect(valuesOf(series, 'app_worker_slots').slice(0, 2)).toEqual([16, null]);
    expect(valuesOf(series, 'app_push_bus_failures').slice(0, 2)).toEqual([3, 0]);
  });

  it('counts the API’s requests by the minute each response ended in, with the server errors and the time most took', () => {
    const series = minuteTable(
      runDataWith({
        appRequests: [
          appRequestWith({ endedAt: at(10), durationMs: 100 }),
          appRequestWith({ endedAt: at(20), durationMs: 900, statusCode: 502 }),
          appRequestWith({ endedAt: at(30), durationMs: 200 }),
          appRequestWith({ endedAt: at(70), durationMs: 50 }),
        ],
      }),
    );

    expect(valuesOf(series, 'app_requests').slice(0, 3)).toEqual([3, 1, 0]);
    expect(valuesOf(series, 'app_requests_5xx').slice(0, 3)).toEqual([1, 0, 0]);
    expect(valuesOf(series, 'app_server_time_p95_ms').slice(0, 3)).toEqual([900, 50, null]);
  });

  it('counts the slices that were down in each minute', () => {
    const down = sliceWith({ down: [{ from: at(100), to: at(130), reason: 'x' }] });
    const data = runDataWith({
      slices: [sliceDataWith(down), sliceDataWith(sliceWith({ generator: 1 }))],
    });

    expect(figures(data, SLICES_DOWN)).toEqual([0, 1, 1, 0]);
  });
});

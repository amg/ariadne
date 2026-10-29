import { describe, expect, it } from 'vitest';
import { AWS_METRIC_RESOURCES, LAYOUT, type ManifestSlice } from '../../records/index.ts';
import {
  at,
  exchangeWith,
  requestWith,
  runDataWith,
  sliceDataWith,
  sliceWith,
} from '../runData/testing.ts';
import { runFiguresOf } from './figures.ts';

const withRequests = (...lines: ReturnType<typeof requestWith>[]) =>
  runDataWith({ slices: [sliceDataWith(sliceWith(), { requests: lines })] });

describe('runFiguresOf', () => {
  it('takes the first byte p95 of the replies that streamed, from the raw lines', () => {
    const lines = [
      ...Array.from({ length: 18 }, (_, index) => requestWith({ firstByteMs: 100 + index })),
      requestWith({ firstByteMs: 3_000 }),
      requestWith({ firstByteMs: 2_900 }),
      requestWith({ kind: 'chat-continue', firstByteMs: 118 }),
      requestWith({ outcome: 'paused', firstByteMs: 9_000 }),
      requestWith({ outcome: 'failed', status: 500, firstByteMs: 9_000 }),
    ];

    // 21 replies streamed, and the 20th of them in order is the 95th percentile.
    expect(runFiguresOf(withRequests(...lines)).chatFirstByteP95Ms).toBe(2_900);
  });

  it('counts sign-ins, refreshes, Threads and chats that failed, and nothing else', () => {
    const data = withRequests(
      requestWith({ kind: 'signin', outcome: 'ok' }),
      requestWith({ kind: 'signin', outcome: 'failed', status: 500 }),
      requestWith({ kind: 'thread', outcome: 'ok' }),
      requestWith({ kind: 'chat', outcome: 'refused', status: 429 }),
      requestWith({ kind: 'chat', outcome: 'expired', status: 401 }),
      requestWith({ kind: 'refresh', outcome: 'ok', status: 200 }),
      requestWith({ kind: 'refresh', outcome: 'failed', status: 401 }),
      requestWith({ kind: 'push', outcome: 'failed', status: null }),
    );

    expect(runFiguresOf(data).errorShare).toBeCloseTo(2 / 7);
  });

  it('knows no error share, and no first byte, for a run with no requests', () => {
    const facts = runFiguresOf(withRequests());
    expect(facts.errorShare).toBeNull();
    expect(facts.chatFirstByteP95Ms).toBeNull();
  });

  it('takes the highest host reading of CPU and memory', () => {
    const sample = {
      at: STARTED_AT,
      perCorePercent: [],
      memoryAvailableBytes: 0,
      swapUsedBytes: 0,
      swapInBytes: 0,
      swapOutBytes: 0,
      loadAverage1: 0,
    };
    const data = runDataWith({
      host: [
        { ...sample, cpuPercent: 20, memoryUsedPercent: 50 },
        { ...sample, cpuPercent: 71, memoryUsedPercent: 40 },
      ],
    });

    expect(runFiguresOf(data)).toMatchObject({ hostCpuPercentMax: 71, memoryUsedPercentMax: 50 });
  });

  it('knows no host figures for a run with no host readings', () => {
    expect(runFiguresOf(runDataWith({ host: null }))).toMatchObject({
      hostCpuPercentMax: null,
      memoryUsedPercentMax: null,
    });
  });
});

const STARTED_AT = '2026-10-15T00:00:05.000Z';

describe('runFiguresOf with a slice that was lost', () => {
  const steady = sliceWith({ generator: 0 });
  const lost = sliceWith({
    generator: 1,
    firstUser: 10,
    down: [{ from: at(60), to: at(122), reason: 'x' }],
  });
  const signIn = (overrides: Parameters<typeof requestWith>[0]) =>
    requestWith({ kind: 'signin', ...overrides });

  it('leaves out the slice’s own failures inside the window it was down', () => {
    const data = runDataWith({
      slices: [
        sliceDataWith(steady, { requests: [signIn({ outcome: 'ok', startedAt: at(90) })] }),
        sliceDataWith(lost, {
          requests: [
            signIn({ generator: 1, outcome: 'failed', status: 503, startedAt: at(90) }),
            signIn({ generator: 1, outcome: 'ok', startedAt: at(130) }),
          ],
        }),
      ],
    });

    expect(runFiguresOf(data).errorShare).toBe(0);
  });

  it('keeps every other slice’s failures in that window, and the slice’s own outside it', () => {
    const data = runDataWith({
      slices: [
        sliceDataWith(steady, {
          requests: [signIn({ outcome: 'failed', status: 503, startedAt: at(90) })],
        }),
        sliceDataWith(lost, {
          requests: [signIn({ generator: 1, outcome: 'failed', status: 503, startedAt: at(123) })],
        }),
      ],
    });

    expect(runFiguresOf(data).errorShare).toBe(1);
  });
});

describe('runFiguresOf, what a sized step is judged by', () => {
  const state = (generatorNumber: number, seconds: number, streams: number, chatters: number) => ({
    run: 'run-1',
    generator: generatorNumber,
    attempt: 1,
    at: at(seconds),
    usersSignedIn: streams,
    pushStreamsOpen: streams,
    chattersActive: chatters,
  });
  /** Both slices hold from the 60th second to the 240th, so minutes 1, 2 and 3 lie inside it. */
  const sliceHeld = (generatorNumber: number, down: ManifestSlice['down'] = []) =>
    sliceWith({
      generator: generatorNumber,
      endedAt: at(300),
      hold: { from: at(60), to: at(240) },
      down,
    });
  const seconds = [10, 40, 70, 100, 130, 160, 190, 220, 250];
  const readings = (
    generatorNumber: number,
    streamsAt: (second: number) => number,
    chattersAt: (second: number) => number = () => 1_000,
    down: ManifestSlice['down'] = [],
  ) =>
    sliceDataWith(sliceHeld(generatorNumber, down), {
      states: seconds.map((second) =>
        state(generatorNumber, second, streamsAt(second), chattersAt(second)),
      ),
    });
  const run = (...slices: ReturnType<typeof sliceDataWith>[]) => runDataWith({ slices });

  it('reads the fewest push streams and chatters held together in any minute of the hold', () => {
    const data = run(
      readings(
        0,
        (second) => (second >= 120 && second < 180 ? 20_000 : 24_500),
        (second) => (second >= 180 && second < 240 ? 4_000 : 5_000),
      ),
      readings(1, () => 24_500),
    );

    expect(runFiguresOf(data)).toMatchObject({
      pushStreamsLeastInHold: 44_500,
      chattersLeastInHold: 4_000 + 1_000,
    });
  });

  it('sees a dip that lasts less than a minute, which a per-minute figure would hide', () => {
    const data = run(
      readings(0, (second) => (second === 130 ? 10_000 : 24_500)),
      readings(1, () => 24_500),
    );

    expect(runFiguresOf(data).pushStreamsLeastInHold).toBe(34_500);
  });

  it('ignores the ramp before the hold and the stretch after it, whatever they held', () => {
    const data = run(
      readings(0, (second) => (second < 60 || second > 240 ? 0 : 5)),
      readings(1, (second) => (second < 60 || second > 240 ? 0 : 5)),
    );

    expect(runFiguresOf(data).pushStreamsLeastInHold).toBe(10);
  });

  it('reads nothing of a run with no hold, or with no state line in it', () => {
    expect(runFiguresOf(runDataWith())).toMatchObject({
      pushStreamsLeastInHold: null,
      chattersLeastInHold: null,
    });
    const silent = run(
      sliceDataWith(sliceHeld(0), { states: [] }),
      sliceDataWith(sliceHeld(1), { states: [] }),
    );
    expect(runFiguresOf(silent).pushStreamsLeastInHold).toBeNull();
  });

  it('leaves out the moments a slice was down, because its users could not hold anything', () => {
    const down = (second: number): number => (second >= 130 && second < 190 ? 0 : 24_500);
    const data = run(
      readings(0, () => 24_500),
      readings(1, down, () => 1_000, [{ from: at(130), to: at(190), reason: 'x' }]),
    );

    // The slice is down from 130 s until it is back, and the hold has half the streams only then.
    expect(runFiguresOf(data).pushStreamsLeastInHold).toBe(49_000);
  });

  it('takes the share of sign-ins that failed, apart from every other kind of request', () => {
    const data = withRequests(
      requestWith({ kind: 'signin', outcome: 'ok' }),
      requestWith({ kind: 'signin', outcome: 'ok' }),
      requestWith({ kind: 'signin', outcome: 'ok' }),
      requestWith({ kind: 'signin', outcome: 'failed', status: 503 }),
      requestWith({ kind: 'refresh', outcome: 'failed', status: 401 }),
      requestWith({ kind: 'chat', outcome: 'failed', status: 500 }),
    );

    expect(runFiguresOf(data).signInFailureShare).toBe(0.25);
    expect(runFiguresOf(withRequests(requestWith({ kind: 'chat' }))).signInFailureShare).toBeNull();
  });

  it('takes the share of the gate’s verdicts that were a wait at its limit, and none a retry replayed', () => {
    const verdict = (overrides: Parameters<typeof exchangeWith>[0]) =>
      exchangeWith({ verdict: 'pass', ...overrides });
    const data = runDataWith({
      exchanges: [
        verdict({}),
        verdict({}),
        verdict({}),
        verdict({ verdict: 'pending', outcome: 'gate-pending' }),
        verdict({ verdictReplayed: true }),
        verdict({ verdict: 'pending', outcome: 'gate-pending', verdictReplayed: true }),
      ],
    });

    expect(runFiguresOf(data).gateWaitAtLimitShare).toBe(0.25);
    expect(runFiguresOf(runDataWith({ exchanges: null })).gateWaitAtLimitShare).toBeNull();
    expect(runFiguresOf(runDataWith({ exchanges: [] })).gateWaitAtLimitShare).toBeNull();
  });

  it('reads the busiest generator’s CPU from the Container Insights metrics the run kept', () => {
    const cluster = (name: string, statistic: string, values: readonly number[]) => ({
      namespace: 'ECS/ContainerInsights',
      name,
      dimensions: { ClusterName: 'load', TaskDefinitionFamily: 'generator' },
      statistic: statistic as 'Average' | 'Maximum',
      periodSeconds: 60,
      points: values.map((value, index) => ({ at: at(index * 60), value })),
    });
    const data = runDataWith({
      awsMetrics: [
        {
          resource: AWS_METRIC_RESOURCES.generatorCluster,
          path: LAYOUT.awsMetrics(AWS_METRIC_RESOURCES.generatorCluster),
          series: [
            cluster('CpuUtilized', 'Maximum', [400, 717, 500]),
            cluster('CpuUtilized', 'Average', [900, 900, 900]),
            cluster('CpuReserved', 'Average', [1_024, 1_024, 1_024]),
          ],
        },
      ],
    });

    // The busiest task's 717 of 1,024 CPU units, not the average the other series would give.
    expect(runFiguresOf(data).generatorCpuPercentMax).toBeCloseTo(70.02, 2);
    expect(runFiguresOf(runDataWith()).generatorCpuPercentMax).toBeNull();
  });

  it('judges the generators’ CPU up to the end of the hold, not while they stop their users', () => {
    const busiest = (values: readonly number[]) => ({
      namespace: 'ECS/ContainerInsights',
      name: 'CpuUtilized',
      dimensions: { ClusterName: 'load', TaskDefinitionFamily: 'generator' },
      statistic: 'Maximum' as const,
      periodSeconds: 60,
      points: values.map((value, index) => ({ at: at(index * 60), value })),
    });
    const reserved = { ...busiest([1_024, 1_024, 1_024]), name: 'CpuReserved' };
    const metrics = [
      {
        resource: AWS_METRIC_RESOURCES.generatorCluster,
        path: LAYOUT.awsMetrics(AWS_METRIC_RESOURCES.generatorCluster),
        series: [busiest([400, 500, 1_020]), { ...reserved, statistic: 'Average' as const }],
      },
    ];
    const heldUntil = (seconds: number) =>
      runDataWith({
        slices: [sliceDataWith(sliceWith({ hold: { from: at(30), to: at(seconds) } }))],
        awsMetrics: metrics,
      });

    // The hold ends 100 s in. The minute from 120 s, when the users were stopped, is not judged.
    expect(runFiguresOf(heldUntil(100)).generatorCpuPercentMax).toBeCloseTo(48.83, 2);
    expect(runFiguresOf(heldUntil(150)).generatorCpuPercentMax).toBeCloseTo(99.61, 2);
  });
});

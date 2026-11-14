import { describe, expect, it } from 'vitest';
import { judge, limitsFor } from '../../criteria/index.ts';
import { AWS_METRIC_RESOURCES, LAYOUT, type MetricSeries } from '../../records/index.ts';
import { reasonText, verdictText } from '../derived/index.ts';
import { runFactsOf } from '../facts/index.ts';
import {
  ENDED,
  at,
  exchangeWith,
  manifestWith,
  requestWith,
  runDataWith,
  sliceDataWith,
  sliceWith,
} from '../runData/testing.ts';
import { minuteTable } from '../table/index.ts';
import { crossCheckChats, crossCheckLoadBalancer } from './crossChecks.ts';
import { decide } from './decide.ts';
import { scalingOf } from './scaling.ts';

/**
 * A run of a sized step with as few records as the judging needs: two
 * generators that each write two state lines in the hold, one sign-in, one
 * chat, one exchange, and the generators' CPU in two minutes.
 */
function runOf(
  step: 'step10' | 'scale10' | 'step50',
  load: { users: number; chattingShare: number },
  held: { secondGeneratorShare: number; busiestCpuUnits: number },
) {
  const config = { name: step, load };
  const perGenerator = load.users / 2;
  const slices = [0, 1].map((generator) =>
    sliceWith({
      generator,
      userCount: perGenerator,
      endedAt: at(170),
      hold: { from: at(30), to: at(150) },
    }),
  );
  const state = (generator: number, seconds: number, share: number) => ({
    run: 'run-1',
    generator,
    attempt: 1,
    at: at(seconds),
    usersSignedIn: perGenerator,
    pushStreamsOpen: Math.round(perGenerator * share),
    chattersActive: perGenerator * load.chattingShare,
  });
  const cpu = (name: string, statistic: 'Average' | 'Maximum', value: number): MetricSeries => ({
    namespace: 'ECS/ContainerInsights',
    name,
    dimensions: { ClusterName: 'load', TaskDefinitionFamily: 'generator' },
    statistic,
    periodSeconds: 60,
    points: [0, 60].map((seconds) => ({ at: at(seconds), value })),
  });
  return runDataWith({
    manifest: manifestWith({
      step,
      config,
      limits: limitsFor(step, config),
      slices,
    }),
    slices: [
      sliceDataWith(slices[0] ?? sliceWith(), {
        requests: [
          requestWith({ kind: 'signin', outcome: 'ok', startedAt: at(10) }),
          requestWith({ kind: 'chat', outcome: 'streamed', startedAt: at(50), firstByteMs: 120 }),
        ],
        states: [state(0, 40, 1), state(0, 100, 1)],
      }),
      sliceDataWith(slices[1] ?? sliceWith(), {
        states: [state(1, 40, 1), state(1, 100, held.secondGeneratorShare)],
      }),
    ],
    exchanges: [exchangeWith({ arrivedAt: at(50), verdict: 'pass' })],
    awsMetrics: [
      {
        resource: AWS_METRIC_RESOURCES.generatorCluster,
        path: LAYOUT.awsMetrics(AWS_METRIC_RESOURCES.generatorCluster),
        series: [
          cpu('CpuUtilized', 'Maximum', held.busiestCpuUnits),
          cpu('CpuReserved', 'Average', 1_024),
        ],
      },
    ],
  });
}

/** Judges a run as a rebuild does, and returns the figures, the verdict and the words. */
function outcomeOf(data: ReturnType<typeof runOf>) {
  const facts = runFactsOf(data);
  const { limits } = facts.run;
  if (limits === null) throw new Error('a sized step records its limits');
  const judgements = judge(limits, facts.figures);
  const crossChecks = [
    ...crossCheckChats(facts),
    ...crossCheckLoadBalancer(minuteTable(data), facts),
  ];
  const scaling = scalingOf({ table: minuteTable(data), facts });
  const decision = decide({ facts, judgements, criteriaUnknown: null, crossChecks, scaling });
  const text = verdictText({ facts, decision, judgements, crossChecks, scaling });
  const byId = Object.fromEntries(judgements.map((judgement) => [judgement.id, judgement]));
  return { byId, decision, reasons: decision.reasons.map(reasonText), text };
}

describe('a run of step50', () => {
  const data = runOf(
    'step50',
    { users: 50_000, chattingShare: 0.2 },
    { secondGeneratorShare: 1, busiestCpuUnits: 390 },
  );

  it('passes when it holds every push stream and chatter, answers fast, and no generator is hot', () => {
    const { byId, decision } = outcomeOf(data);

    expect(decision.verdict).toBe('pass');
    expect(byId['push-streams']).toMatchObject({ limit: 49_000, observed: 50_000, result: 'pass' });
    expect(byId.chatters).toMatchObject({ limit: 9_800, observed: 10_000, result: 'pass' });
    expect(byId['first-byte-p95']).toMatchObject({ observed: 120, result: 'pass' });
    expect(byId['sign-in-failures']).toMatchObject({ observed: 0, result: 'pass' });
    expect(byId['gate-waits-at-limit']).toMatchObject({ observed: 0, result: 'pass' });
    expect(byId['generator-cpu']?.observed).toBeCloseTo(38.1, 1);
  });

  it('writes its limits in the verdict, each in the direction it is held', () => {
    const { text } = outcomeOf(data);

    expect(text).toContain(
      '| Push streams open through the hold | at least 49,000 | 50,000 | pass |',
    );
    expect(text).toContain('| Busiest generator CPU | at most 70% | 38.1% | pass |');
  });
});

describe('a run of step10', () => {
  const load = { users: 10_000, chattingShare: 0.2 };

  it('is judged by the same criteria as step50, with lines scaled to its users', () => {
    const step10 = outcomeOf(
      runOf('step10', load, { secondGeneratorShare: 1, busiestCpuUnits: 500 }),
    );
    const step50 = outcomeOf(
      runOf(
        'step50',
        { users: 50_000, chattingShare: 0.2 },
        { secondGeneratorShare: 1, busiestCpuUnits: 500 },
      ),
    );

    expect(Object.keys(step10.byId)).toEqual(Object.keys(step50.byId));
    expect(step10.byId['push-streams']?.limit).toBe(9_800);
    expect(step10.byId.chatters?.limit).toBe(1_960);
    expect(step10.decision.verdict).toBe('pass');
  });

  it('fails when a generator loses a fifth of its push streams, saying it fell short', () => {
    const { byId, decision, reasons } = outcomeOf(
      runOf('step10', load, { secondGeneratorShare: 0.8, busiestCpuUnits: 500 }),
    );

    expect(decision.verdict).toBe('fail');
    expect(byId['push-streams']).toMatchObject({ limit: 9_800, observed: 9_000, result: 'fail' });
    expect(byId.chatters?.result).toBe('pass');
    expect(reasons).toEqual([
      'Push streams open through the hold was 9,000, short of its limit (at least 9,800)',
    ]);
  });

  it('fails when the busiest generator is over its CPU line, saying it went past', () => {
    const { reasons } = outcomeOf(
      runOf('step10', load, { secondGeneratorShare: 1, busiestCpuUnits: 800 }),
    );

    expect(reasons).toEqual(['Busiest generator CPU was 78.1%, past its limit (at most 70%)']);
  });
});

describe('a run of step50 that breaks one criterion only', () => {
  type Data = ReturnType<typeof runOf>;
  const healthy = runOf(
    'step50',
    { users: 50_000, chattingShare: 0.2 },
    { secondGeneratorShare: 1, busiestCpuUnits: 390 },
  );

  /** The same run with extra requests on its first slice. */
  const withRequests = (data: Data, ...requests: ReturnType<typeof requestWith>[]): Data => ({
    ...data,
    slices: data.slices.map((slice, index) =>
      index === 0 ? { ...slice, requests: [...(slice.requests ?? []), ...requests] } : slice,
    ),
  });

  const breaking: [string, (data: Data) => Data][] = [
    [
      'push-streams',
      (data) => ({
        ...data,
        slices: data.slices.map((slice) => ({
          ...slice,
          states: (slice.states ?? []).map((state) => ({ ...state, pushStreamsOpen: 24_000 })),
        })),
      }),
    ],
    [
      'chatters',
      (data) => ({
        ...data,
        slices: data.slices.map((slice) => ({
          ...slice,
          states: (slice.states ?? []).map((state) => ({ ...state, chattersActive: 4_000 })),
        })),
      }),
    ],
    [
      'first-byte-p95',
      (data) =>
        withRequests(
          data,
          ...[50, 51, 52, 53, 54].map((seconds) =>
            requestWith({
              kind: 'chat',
              outcome: 'streamed',
              startedAt: at(seconds),
              firstByteMs: 4_000,
            }),
          ),
        ),
    ],
    [
      'sign-in-failures',
      (data) =>
        withRequests(
          data,
          requestWith({ kind: 'signin', outcome: 'failed', status: 503, startedAt: at(11) }),
        ),
    ],
    [
      'gate-waits-at-limit',
      (data) => ({
        ...data,
        exchanges: [
          ...(data.exchanges ?? []),
          exchangeWith({ arrivedAt: at(60), verdict: 'pending', outcome: 'gate-pending' }),
        ],
      }),
    ],
    [
      'generator-cpu',
      () =>
        runOf(
          'step50',
          { users: 50_000, chattingShare: 0.2 },
          { secondGeneratorShare: 1, busiestCpuUnits: 800 },
        ),
    ],
  ];

  it('passes every criterion before anything is broken', () => {
    const results = Object.values(outcomeOf(healthy).byId).map(({ result }) => result);

    expect(results).toHaveLength(6);
    expect(new Set(results)).toEqual(new Set(['pass']));
  });

  it.each(breaking)('fails %s, and nothing else', (id, breakIt) => {
    const { byId } = outcomeOf(breakIt(healthy));

    expect(
      Object.entries(byId)
        .filter(([, judgement]) => judgement.result !== 'pass')
        .map(([name]) => name),
    ).toEqual([id]);
    expect(byId[id]?.result).toBe('fail');
  });
});

describe('a run of scale10', () => {
  /** The watch after the run ends seven minutes after the run does. */
  const WATCH_ENDS = at(600);
  const services = {
    api: { count: 2, scaling: { maxCount: 6, targetCpuPercent: 65 } },
    auth: { count: 2, scaling: { maxCount: 8, targetCpuPercent: 60 } },
    web: { count: 2 },
  };

  /** A service's running tasks, one figure a minute from the run's start. */
  const runningTasks = (service: string, tasksByMinute: readonly number[]) => ({
    resource: AWS_METRIC_RESOURCES.service(service),
    path: LAYOUT.awsMetrics(AWS_METRIC_RESOURCES.service(service)),
    series: [
      {
        namespace: 'ECS/ContainerInsights',
        name: 'RunningTaskCount',
        dimensions: { ClusterName: 'app', ServiceName: `app-${service}` },
        statistic: 'Average' as const,
        periodSeconds: 60,
        points: tasksByMinute.map((value, minute) => ({ at: at(minute * 60), value })),
      },
    ],
  });

  /** A scale10 run whose services ran these tasks, watched for seven minutes after it ended. */
  function scaleRunOf(tasks: { api: readonly number[]; auth?: readonly number[] }) {
    const base = runOf(
      'scale10',
      { users: 10_000, chattingShare: 0.2 },
      { secondGeneratorShare: 1, busiestCpuUnits: 500 },
    );
    return {
      ...base,
      manifest: {
        ...base.manifest,
        config: { ...base.manifest.config, services },
        trailingEndsAt: WATCH_ENDS,
      },
      afterRun: {
        from: ENDED,
        to: WATCH_ENDS,
        exchanges: [],
        jobs: [],
        appRequests: [],
        appStates: [],
      },
      awsMetrics: [
        ...base.awsMetrics,
        runningTasks('api', tasks.api),
        ...(tasks.auth === undefined ? [] : [runningTasks('auth', tasks.auth)]),
      ],
    };
  }

  const backDown = {
    api: [2, 2, 4, 5, 5, 3, 2, 2, 2, 2],
    auth: [2, 3, 3, 2, 2, 2, 2, 2, 2, 2],
  };

  it('passes when every service that scaled is back at its floor by the end of the watch', () => {
    const { decision, byId } = outcomeOf(scaleRunOf(backDown));

    expect(decision).toEqual({ verdict: 'pass', reasons: [] });
    expect(byId['push-streams']?.limit).toBe(9_800);
  });

  it('shows each service that scales: its floor and ceiling, its peak and when it was back at its floor', () => {
    const { text } = outcomeOf(scaleRunOf(backDown));

    expect(text).toContain(`The watch after the run ended at ${WATCH_ENDS}.`);
    expect(text).toContain(`| api | 2 to 6 | 5 | ${at(180)} | ${at(360)} | 2 |`);
    expect(text).toContain(`| auth | 2 to 8 | 3 | ${at(60)} | ${at(180)} | 2 |`);
    expect(text).not.toContain('| web |');
  });

  it('fails when a service still runs above its floor at the end of the watch, naming it and its tasks', () => {
    const { decision, reasons, text } = outcomeOf(
      scaleRunOf({ ...backDown, api: [2, 2, 4, 5, 5, 4, 3, 3, 3, 3] }),
    );

    expect(decision.verdict).toBe('fail');
    expect(reasons).toEqual([
      'api still ran 3 tasks at the end of the watch after the run, above its floor of 2',
    ]);
    expect(text).toContain(`| api | 2 to 6 | 5 | ${at(180)} | not back | 3 |`);
  });

  it('says a service that never went above its floor never left it', () => {
    const { text } = outcomeOf(scaleRunOf({ ...backDown, auth: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2] }));

    expect(text).toContain(`| auth | 2 to 8 | 2 | ${at(0)} | never left it | 2 |`);
  });

  it('cannot pass when it recorded none of a scaling service’s running tasks', () => {
    const { decision, reasons } = outcomeOf(scaleRunOf({ api: backDown.api }));

    expect(decision.verdict).toBe('incomplete');
    expect(reasons).toEqual([
      `auth scales, and the run recorded none of its running tasks at the end of the watch (${WATCH_ENDS}) to judge it back at its floor by`,
    ]);
  });

  it('does not take a service whose readings stop before the end of the watch as back at its floor', () => {
    // The API's readings stop four minutes before the watch ends, still above its floor.
    const { decision, reasons, text } = outcomeOf(
      scaleRunOf({ ...backDown, api: [2, 2, 4, 5, 5, 3] }),
    );

    expect(decision.verdict).toBe('incomplete');
    expect(reasons).toEqual([
      `api scales, and the run recorded none of its running tasks at the end of the watch (${WATCH_ENDS}) to judge it back at its floor by`,
    ]);
    expect(text).toContain(`| api | 2 to 6 | 5 | ${at(180)} | not back | n/a |`);
  });

  it('takes a reading a minute or two short of the end of the watch as its end, since CloudWatch delivers late', () => {
    const { decision } = outcomeOf(scaleRunOf({ ...backDown, api: [2, 2, 4, 5, 5, 3, 2, 2] }));

    expect(decision.verdict).toBe('pass');
  });

  it('does not count the push streams users closed as they left in the fall, and counts one cut under a user still there', () => {
    const data = scaleRunOf(backDown);
    // The hold ends at second 150: three users leave in the fall, and one loses its stream before it leaves.
    const stream = (user: number, lastedSeconds: number, outcome: 'held' | 'failed') =>
      requestWith({
        kind: 'push',
        user,
        startedAt: at(20),
        firstByteMs: 20,
        totalMs: lastedSeconds * 1_000,
        status: 200,
        outcome,
      });
    const falling = {
      ...data,
      slices: data.slices.map((slice, index) =>
        index === 0
          ? {
              ...slice,
              requests: [
                ...(slice.requests ?? []),
                stream(3, 135, 'held'),
                stream(2, 140, 'failed'),
                stream(1, 145, 'held'),
                stream(0, 150, 'held'),
              ],
            }
          : slice,
      ),
    };

    const { decision, text } = outcomeOf(falling);

    expect(decision.verdict).toBe('pass');
    expect(text).toContain('| Ended before their users let them go | 1 |');
    expect(text).toContain('| Of those, cut off rather than closed | 1 |');
  });
});

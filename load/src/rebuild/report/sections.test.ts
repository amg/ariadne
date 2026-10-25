import { describe, expect, it } from 'vitest';
import { AWS_PROD_TARGET, type MetricSeries } from '../../records/index.ts';
import type { Judgement } from '../../types/criteria.ts';
import { runFactsOf } from '../facts/index.ts';
import {
  appRequestWith,
  appStateWith,
  at,
  exchangeWith,
  manifestWith,
  requestWith,
  runDataWith,
  sliceDataWith,
  sliceWith,
} from '../runData/testing.ts';
import { minuteTable } from '../table/index.ts';
import type { Gap, RunData, RunFacts } from '../types.ts';
import { reportSections } from './sections.ts';

const judgements: Judgement[] = [
  {
    id: 'host-cpu',
    title: 'Host CPU',
    unit: 'percent',
    direction: 'at-most',
    limit: 70,
    observed: 40,
    result: 'pass',
  },
  {
    id: 'errors',
    title: 'Requests that failed',
    unit: 'share',
    direction: 'at-most',
    limit: 0.01,
    observed: 0,
    result: 'pass',
  },
];

const gap = (source: string) => ({
  source,
  from: at(10),
  to: at(40),
  reason: 'no reading for 30 s',
});

/** A home run whose every source of its own has a reading in its first minute. */
const homeRun = (overrides: Partial<RunData> = {}): RunData =>
  runDataWith({
    slices: [
      sliceDataWith(sliceWith(), {
        requests: [requestWith(), requestWith({ kind: 'signin', outcome: 'ok' })],
        states: [
          {
            run: 'run-1',
            generator: 0,
            attempt: 1,
            at: at(20),
            usersSignedIn: 1,
            pushStreamsOpen: 1,
            chattersActive: 1,
          },
        ],
      }),
    ],
    host: [
      {
        at: at(30),
        cpuPercent: 40,
        perCorePercent: [40],
        memoryAvailableBytes: 1_000_000,
        memoryUsedPercent: 50,
        swapUsedBytes: 0,
        swapInBytes: 0,
        swapOutBytes: 0,
        loadAverage1: 1,
      },
    ],
    appStates: [appStateWith({ copy: null, at: at(30), pushStreamsOpen: 1, oldestJobWaitMs: 0 })],
    ...overrides,
  });

type Failures = RunFacts['summary']['requests']['failures'];

const sectionsOf = (
  data: RunData,
  gaps: readonly Gap[] = [],
  own = judgements,
  failures: Failures | null = null,
) => {
  const facts = runFactsOf(data);
  return reportSections({
    facts: {
      ...facts,
      gaps,
      summary: {
        ...facts.summary,
        requests: {
          ...facts.summary.requests,
          failures: failures ?? facts.summary.requests.failures,
        },
      },
    },
    table: minuteTable(data),
    judgements: own,
  });
};

const chartsOf = (data: RunData, gaps: readonly Gap[] = [], own = judgements) =>
  sectionsOf(data, gaps, own).flatMap((section) => section.charts);

const titlesShaded = (data: RunData, gaps: readonly Gap[]) =>
  chartsOf(data, gaps)
    .filter((chart) => chart.gaps.length > 0)
    .map((chart) => chart.title);

/** A run on aws-prod whose database file holds the CPU it reported in its first minute. */
function awsRun(overrides: Partial<RunData> = {}): RunData {
  const cpu: MetricSeries = {
    namespace: 'AWS/RDS',
    name: 'CPUUtilization',
    dimensions: { DBInstanceIdentifier: 'db' },
    statistic: 'Maximum',
    periodSeconds: 60,
    points: [{ at: at(0), value: 12 }],
  };
  return homeRun({
    manifest: manifestWith({ target: AWS_PROD_TARGET, limits: {} }),
    host: null,
    awsMetrics: [{ resource: 'database', path: 'metrics/aws/database.jsonl', series: [cpu] }],
    ...overrides,
  });
}

describe('reportSections', () => {
  it('draws how loaded each copy was and what the API answered, only for a run that kept them', () => {
    const titles = (data: RunData) => chartsOf(data).map((chart) => chart.title);
    const kept = homeRun({
      appStates: [appStateWith({ at: at(30), eventLoopDelayP99Ms: 12, dbConnectionsInUse: 3 })],
      appRequests: [appRequestWith({ endedAt: at(30) })],
    });

    expect(titles(kept)).toEqual(
      expect.arrayContaining([
        'Event loop delay, busiest copy',
        'Database connections, busiest copy',
        'Requests the API answered',
        'Server time per request',
      ]),
    );
    expect(titles(homeRun({ appRequests: null }))).not.toEqual(
      expect.arrayContaining(['Event loop delay, busiest copy', 'Requests the API answered']),
    );
  });

  it('follows the live dashboard’s rows, and puts the home machine after them', () => {
    expect(sectionsOf(homeRun()).map((section) => section.heading)).toEqual([
      'What users see',
      'The generators against their limits',
      'What the app sees',
      'The host',
    ]);
  });

  it('leaves out the home machine on a run that has none, and draws what CloudWatch kept', () => {
    expect(sectionsOf(awsRun()).map((section) => section.heading)).toEqual([
      'What users see',
      'The generators against their limits',
      'What the app sees',
      'The database',
    ]);
  });

  it('leaves out a chart whose lines carry no value, and a line with neither value nor gap', () => {
    const titles = chartsOf(awsRun()).map((chart) => chart.title);

    expect(titles).toContain('CPU');
    expect(titles).not.toContain('Sessions busy at once');
    expect(
      chartsOf(awsRun()).find((chart) => chart.title === 'Push streams per API task')?.lines,
    ).toHaveLength(2);
  });

  it('keeps a line with no value where its records have a gap, so that the gap shows', () => {
    const chart = chartsOf(homeRun({ jobs: null }), [gap('app/jobs.jsonl')]).find(
      (own) => own.title === 'Time jobs wait in the queue',
    );

    expect(chart?.lines.map((line) => line.label)).toEqual([
      'p50 of jobs started',
      'p95 of jobs started',
      'oldest job waiting',
    ]);
    expect(chart?.gaps).toHaveLength(1);
  });
});

describe('the pass lines', () => {
  const limitOf = (data: RunData, title: string, own = judgements) =>
    chartsOf(data, [], own).find((chart) => chart.title === title)?.passLine;

  it('draws a criterion’s limit on the chart that carries it, in that chart’s unit', () => {
    expect(limitOf(homeRun(), 'Host CPU')).toEqual({ label: 'host CPU at most 70%', value: 70 });
    expect(limitOf(homeRun(), 'Requests that failed')).toEqual({
      label: 'failed at most 1%',
      value: 1,
    });
    expect(limitOf(homeRun(), 'Users online')).toBeNull();
    expect(limitOf(homeRun(), 'Memory in use')).toBeNull();
  });

  it('draws the live dashboard’s line on an aws-prod run whose criteria set none', () => {
    expect(limitOf(awsRun(), 'Chat first byte', [])).toEqual({
      label: 'p95 pass line 2500 ms',
      value: 2_500,
    });
    expect(limitOf(awsRun(), 'Sign-in failures', [])).toEqual({
      label: 'failed pass line 0.5%',
      value: 0.5,
    });
  });

  it('draws a sized step’s criterion held from below as a limit to stay above, in the chart’s unit', () => {
    const own: Judgement[] = [
      {
        id: 'push-streams',
        title: 'Push streams open through the hold',
        unit: 'count',
        direction: 'at-least',
        limit: 49_000,
        observed: 49_500,
        result: 'pass',
      },
      {
        id: 'chatters',
        title: 'Chatters active through the hold',
        unit: 'count',
        direction: 'at-least',
        limit: 9_800,
        observed: 9_900,
        result: 'pass',
      },
      {
        id: 'generator-cpu',
        title: 'Busiest generator CPU',
        unit: 'percent',
        direction: 'at-most',
        limit: 70,
        observed: 60,
        result: 'pass',
      },
      {
        id: 'gate-waits-at-limit',
        title: 'Gate waits that hit the limit',
        unit: 'share',
        direction: 'at-most',
        limit: 0.005,
        observed: 0,
        result: 'pass',
      },
    ];

    const cpu = (name: string, statistic: 'Average' | 'Maximum', value: number): MetricSeries => ({
      namespace: 'ECS/ContainerInsights',
      name,
      dimensions: { ClusterName: 'load', TaskDefinitionFamily: 'generator' },
      statistic,
      periodSeconds: 60,
      points: [{ at: at(0), value }],
    });
    const run = awsRun({
      exchanges: [exchangeWith({ arrivedAt: at(10), verdict: 'pass' })],
      awsMetrics: [
        {
          resource: 'ecs-cluster-generator',
          path: 'metrics/aws/ecs-cluster-generator.jsonl',
          series: [
            cpu('CpuUtilized', 'Maximum', 512),
            cpu('CpuUtilized', 'Average', 300),
            cpu('CpuReserved', 'Average', 1_024),
          ],
        },
      ],
    });

    expect(limitOf(run, 'Users online', own)).toEqual({
      label: 'push streams at least 49,000',
      value: 49_000,
    });
    expect(limitOf(run, 'Chatters active', own)).toEqual({
      label: 'chatters at least 9,800',
      value: 9_800,
    });
    expect(limitOf(run, 'Generator CPU', own)).toEqual({
      label: 'busiest generator at most 70%',
      value: 70,
    });
    expect(limitOf(run, 'Gate waits that hit the limit', own)).toEqual({
      label: 'waits at most 0.5%',
      value: 0.5,
    });
  });

  it('draws no live line on a home run, whose limits are its own', () => {
    expect(limitOf(homeRun(), 'Chat first byte', [])).toBeNull();
    expect(limitOf(homeRun(), 'Sign-in failures', [])).toBeNull();
  });
});

describe('what a gap touches', () => {
  it('shades a gap only on the charts that draw from the source it is in', () => {
    expect(titlesShaded(homeRun(), [gap('metrics/host.jsonl')])).toEqual([
      'Host CPU',
      'Memory in use',
    ]);
  });

  it('shades a slice that was down on every chart drawn from the generators', () => {
    expect(titlesShaded(homeRun(), [gap('generator 0')])).toEqual([
      'Users online',
      'Chatters active',
      'Chat first byte',
      'Failures by kind',
      'Requests that failed',
      'Sign-in failures',
    ]);
  });

  it('shades a missing request window only where requests are drawn', () => {
    expect(titlesShaded(homeRun(), [gap('requests/generator-0.jsonl')])).toEqual([
      'Chat first byte',
      'Failures by kind',
      'Requests that failed',
      'Sign-in failures',
    ]);
  });

  it('shades a CloudWatch file that cannot be used on the charts drawn from it', () => {
    expect(titlesShaded(awsRun(), [gap('metrics/aws/database.jsonl')])).toEqual(['CPU']);
  });
});

describe('the failure charts', () => {
  const requests = (outcome: 'failed' | 'ok', kind: 'signin' | 'chat') =>
    requestWith({ outcome, kind, errorCode: outcome === 'failed' ? 'unreachable' : null });
  const failuresChart = (...lines: ReturnType<typeof requestWith>[]) =>
    chartsOf(runDataWith({ slices: [sliceDataWith(sliceWith(), { requests: lines })] })).find(
      (chart) => chart.title === 'Failures by kind',
    );

  it('draws a line for each kind that failed, and for no other', () => {
    const chart = failuresChart(requests('failed', 'signin'), requests('ok', 'chat'));

    expect(chart?.lines.map((line) => line.label)).toEqual(['signin']);
  });

  it('draws one line of nothing when no request failed', () => {
    const chart = failuresChart(requests('ok', 'chat'));

    expect(chart?.lines.map((line) => line.label)).toEqual(['none']);
  });
});

describe('the moments the charts mark', () => {
  const launchedAt = (seconds: number, generator: number) => ({
    kind: 'generator-launched' as const,
    at: at(seconds),
    generator,
    attempt: 1,
    firstUser: 0,
    userCount: 10,
    task: 'pid-1',
    spot: false,
    planned: null,
  });

  it('marks each moment inside the run on every chart, lists it, and leaves out one after the run', () => {
    const data = homeRun({ events: [launchedAt(30, 0), launchedAt(3_600, 1)] });
    const sections = sectionsOf(data);

    for (const chart of sections.flatMap((section) => section.charts)) {
      expect(chart.markers).toEqual([{ at: Date.parse(at(30)), number: 1 }]);
    }
    expect(sections.at(-1)?.tables[0]?.rows.map((row) => row[0])).toEqual([1]);
  });

  it('lists no moments, and marks none, when nothing happened inside the run', () => {
    const sections = sectionsOf(homeRun({ events: [] }));

    expect(sections.flatMap((section) => section.charts.flatMap((chart) => chart.markers))).toEqual(
      [],
    );
    expect(sections.flatMap((section) => section.tables)).toHaveLength(1);
  });
});

describe('the failures table', () => {
  const failuresTable = (failures: Failures) => {
    return sectionsOf(homeRun(), [], judgements, failures)
      .flatMap((section) => section.tables)
      .find((table) => table.caption.startsWith('Failures'));
  };

  it('lists each kind, status and error code with its count, even with no status or code', () => {
    const table = failuresTable([
      { kind: 'signin', status: null, errorCode: 'unreachable', count: 4 },
      { kind: 'chat', status: 503, errorCode: null, count: 12 },
    ]);

    expect(table?.rows.map((row) => [row[0], row.at(-1)])).toEqual([
      ['signin', 4],
      ['chat', 12],
    ]);
  });

  it('has no rows when nothing failed', () => {
    expect(failuresTable([])?.rows).toEqual([]);
  });
});

describe('a run with no records at all', () => {
  it('keeps only the count of failures, which says that none failed', () => {
    const data = runDataWith();
    const sections = reportSections({
      facts: runFactsOf(data),
      table: { minutes: [], afterRunFrom: null, columns: [] },
      judgements,
    });

    expect(sections.map((section) => section.heading)).toEqual(['What users see']);
    expect(sections[0]?.charts).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import type { AwsEvent, MetricSeries } from '../../../records/index.ts';
import { MINUTE_MS } from '../../moments.ts';
import { STARTED, runDataWith } from '../../runData/testing.ts';
import { awsColumns, perMinute, seriesMatching, waitColumns } from './awsColumns.ts';

const MINUTE_0 = Date.parse(STARTED);
const minute = (index: number) => new Date(MINUTE_0 + index * MINUTE_MS).toISOString();

const seriesWith = (overrides: Partial<MetricSeries> = {}) => ({
  namespace: 'AWS/RDS',
  name: 'CPUUtilization',
  dimensions: { DBInstanceIdentifier: 'db' },
  statistic: 'Maximum',
  periodSeconds: 60,
  points: [{ at: minute(0), value: 10 }],
  ...overrides,
});

const resource = (name: string, series: readonly MetricSeries[]) => ({
  resource: name,
  path: `metrics/aws/${name}.jsonl`,
  series,
});

const CPU: Parameters<typeof seriesMatching>[1] = {
  namespace: 'AWS/RDS',
  name: 'CPUUtilization',
  statistic: 'Maximum',
  dimensions: ['DBInstanceIdentifier'],
};

describe('seriesMatching', () => {
  it('takes the statistic the figure names, out of every one CloudWatch delivered', () => {
    const metrics = resource('database', [
      seriesWith({ statistic: 'Average' }),
      seriesWith({ statistic: 'Maximum' }),
      seriesWith({ statistic: 'Sum' }),
    ]);

    expect(seriesMatching(metrics, CPU).map((series) => series.statistic)).toEqual(['Maximum']);
  });

  it('takes only series that carry exactly the dimensions named, so that a breakdown is not counted twice', () => {
    const metrics = resource('load-balancer', [
      seriesWith({ dimensions: { DBInstanceIdentifier: 'db' } }),
      seriesWith({ dimensions: { DBInstanceIdentifier: 'db', DatabaseInsightsMode: 'standard' } }),
    ]);

    expect(seriesMatching(metrics, CPU)).toHaveLength(1);
  });

  it('takes only series whose dimensions hold the values asked for', () => {
    const usage = (resource: string) =>
      seriesWith({
        namespace: 'AWS/Usage',
        name: 'ResourceCount',
        dimensions: { Resource: resource, Class: 'None' },
      });
    const metrics = resource('fargate-usage', [usage('OnDemand'), usage('Spot')]);
    const query: Parameters<typeof seriesMatching>[1] = {
      namespace: 'AWS/Usage',
      name: 'ResourceCount',
      statistic: 'Maximum',
      dimensions: ['Resource', 'Class'],
      where: { Resource: 'Spot' },
    };

    expect(seriesMatching(metrics, query).map((series) => series.dimensions.Resource)).toEqual([
      'Spot',
    ]);
  });
});

describe('perMinute', () => {
  const two = [
    seriesWith({ points: [{ at: minute(0), value: 3 }] }),
    seriesWith({
      points: [
        { at: minute(0), value: 5 },
        { at: minute(2), value: 7 },
      ],
    }),
  ];

  it('adds up the series of a count, and takes the highest of a level', () => {
    expect(perMinute(two, 'sum')(MINUTE_0)).toBe(8);
    expect(perMinute(two, 'max')(MINUTE_0)).toBe(5);
  });

  it('scales each figure into the unit the report shows', () => {
    expect(perMinute(two, 'max', 1_000)(MINUTE_0)).toBe(5_000);
  });

  it('leaves a minute with no point empty, never carrying a figure across it', () => {
    const at = perMinute(two, 'sum');

    expect(at(MINUTE_0 + MINUTE_MS)).toBeNull();
    expect(at(MINUTE_0 + 2 * MINUTE_MS)).toBe(7);
  });
});

describe('awsColumns', () => {
  const serviceCpu = (service: string, value: number) =>
    seriesWith({
      namespace: 'AWS/ECS',
      dimensions: { ClusterName: 'app', ServiceName: service },
      statistic: 'Average',
      points: [{ at: minute(0), value }],
    });
  const healthy = (group: string) =>
    seriesWith({
      namespace: 'AWS/ApplicationELB',
      name: 'HealthyHostCount',
      dimensions: { LoadBalancer: 'app/lb/1', TargetGroup: `targetgroup/${group}/1` },
      statistic: 'Minimum',
    });
  const registered: AwsEvent = {
    at: minute(0),
    source: 'ecs-service',
    resource: 'AriAwsApp-ServicesApiService-1',
    summary:
      '(service AriAwsApp-ServicesApiService-1) registered 1 targets in (target-group arn:aws:elasticloadbalancing:ap-southeast-2:1:targetgroup/TG-A/abc)',
    detail: {},
  };
  const data = runDataWith({
    awsMetrics: [
      resource('ecs-service-worker', [serviceCpu('AriAwsApp-ServicesWorkerService-1', 30)]),
      resource('ecs-service-api', [serviceCpu('AriAwsApp-ServicesApiService-1', 12)]),
      resource('target-group-TG-A', [healthy('TG-A')]),
      resource('target-group-TG-B', [healthy('TG-B')]),
      resource('load-balancer', [
        seriesWith({
          namespace: 'AWS/ApplicationELB',
          name: 'TargetResponseTime',
          dimensions: { LoadBalancer: 'app/lb/1' },
          statistic: 'Average',
          points: [{ at: minute(0), value: 0.25 }],
        }),
      ]),
      resource('database', [
        seriesWith({
          name: 'FreeStorageSpace',
          statistic: 'Average',
          points: [{ at: minute(0), value: 2 * 1024 ** 3 }],
        }),
      ]),
    ],
    awsEvents: [registered],
  });
  const columns = awsColumns(data);
  const figureOf = (name: string) => columns.find((column) => column.name === name)?.at(MINUTE_0);

  it('makes one column for each service, named and labelled after it', () => {
    const cpu = columns.filter((column) => column.of?.figure === 'service_cpu_average_percent');

    expect(cpu.map((column) => [column.name, column.of?.value, column.at(MINUTE_0)])).toEqual([
      ['service_cpu_average_percent_api', 'api', 12],
      ['service_cpu_average_percent_worker', 'worker', 30],
    ]);
    expect(cpu[0]?.of?.source).toBe('metrics/aws/ecs-service-api.jsonl');
  });

  it('names a target group after the service the services’ events put behind it, or by its own name', () => {
    const groups = columns.filter((column) => column.of?.figure === 'target_group_healthy');

    expect(groups.map((column) => column.of?.value)).toEqual(['api', 'TG-B']);
  });

  it('gives each figure in the unit the report shows it in', () => {
    expect(figureOf('rds_free_storage_gib')).toBe(2);
    expect(figureOf('balancer_response_average_ms')).toBe(250);
  });

  it('reads the vCPU of each kind of Fargate capacity, and not the count of its tasks', () => {
    const usage = (resourceName: string, className: string, value: number) =>
      seriesWith({
        namespace: 'AWS/Usage',
        name: 'ResourceCount',
        dimensions: {
          Type: 'Resource',
          Resource: resourceName,
          Service: 'Fargate',
          Class: className,
        },
        points: [{ at: minute(0), value }],
      });
    const withUsage = awsColumns(
      runDataWith({
        awsMetrics: [
          resource('fargate-usage', [
            usage('OnDemand', 'None', 7),
            usage('vCPU', 'Standard/OnDemand', 7.25),
            usage('Spot', 'None', 4),
            usage('vCPU', 'Standard/Spot', 4.5),
          ]),
        ],
      }),
    );
    const figure = (name: string) => withUsage.find((column) => column.name === name)?.at(MINUTE_0);

    expect(figure('fargate_on_demand_vcpu')).toBe(7.25);
    expect(figure('fargate_spot_vcpu')).toBe(4.5);
  });
});

describe('the generators’ CPU', () => {
  const insight = (name: string, statistic: 'Average' | 'Maximum', values: readonly number[]) =>
    seriesWith({
      namespace: 'ECS/ContainerInsights',
      name,
      dimensions: { ClusterName: 'load', TaskDefinitionFamily: 'generator' },
      statistic,
      points: values.map((value, index) => ({ at: minute(index), value })),
    });
  const data = runDataWith({
    awsMetrics: [
      resource('ecs-cluster-generator', [
        insight('CpuUtilized', 'Average', [300, 400]),
        insight('CpuUtilized', 'Maximum', [512, 900]),
        insight('CpuReserved', 'Average', [1_024, 1_024]),
      ]),
    ],
  });
  const at = (name: string, index: number) =>
    awsColumns(data)
      .find((column) => column.name === name)
      ?.at(MINUTE_0 + index * MINUTE_MS);

  it('gives what all the generators used together, and what the busiest one used, of what each reserved', () => {
    expect(at('generators_cpu_percent', 0)).toBeCloseTo(29.3, 1);
    expect(at('generators_cpu_busiest_percent', 0)).toBe(50);
    expect(at('generators_cpu_busiest_percent', 1)).toBeCloseTo(87.9, 1);
  });

  it('gives nothing for a minute the metrics have no point in', () => {
    expect(at('generators_cpu_busiest_percent', 2)).toBeNull();
  });

  it('is not made when the run kept no metrics of the generators’ cluster', () => {
    const names = awsColumns(runDataWith()).map((column) => column.name);

    expect(names).not.toContain('generators_cpu_busiest_percent');
  });
});

describe('waitColumns', () => {
  it('makes one column for each wait, with the sessions it held each minute', () => {
    const insight = (name: string, value: number) => ({
      group: 'wait' as const,
      dimensions: { 'db.wait_event.name': name, 'db.wait_event.type': 'IO' },
      at: minute(0),
      averageActiveSessions: value,
    });
    const columns = waitColumns(
      runDataWith({ insights: [insight('IO:WALSync', 0.12), insight('CPU', 0.05)] }),
    );

    expect(columns.map((column) => [column.name, column.of?.value, column.at(MINUTE_0)])).toEqual([
      ['db_wait_CPU', 'CPU', 0.05],
      ['db_wait_IO_WALSync', 'IO:WALSync', 0.12],
    ]);
  });
});

describe('the load balancer, zone by zone', () => {
  const balancerSeries = (name: string, zone: string | null, value: number) =>
    seriesWith({
      namespace: 'AWS/ApplicationELB',
      name,
      statistic: 'Sum',
      dimensions: {
        LoadBalancer: 'app/lb/1',
        ...(zone === null ? {} : { AvailabilityZone: zone }),
      },
      points: [{ at: minute(0), value }],
    });

  it('splits connections and requests by zone, beside the totals', () => {
    const columns = awsColumns(
      runDataWith({
        awsMetrics: [
          resource('load-balancer', [
            balancerSeries('NewConnectionCount', null, 3_000),
            balancerSeries('NewConnectionCount', 'ap-southeast-2a', 2_000),
            balancerSeries('NewConnectionCount', 'ap-southeast-2b', 1_000),
            balancerSeries('ActiveConnectionCount', 'ap-southeast-2a', 7_800),
          ]),
        ],
      }),
    );
    const figures = Object.fromEntries(columns.map((column) => [column.name, column.at(MINUTE_0)]));

    expect(figures).toMatchObject({
      balancer_new_connections: 3_000,
      balancer_new_connections_by_zone_ap_southeast_2a: 2_000,
      balancer_new_connections_by_zone_ap_southeast_2b: 1_000,
      balancer_active_connections_by_zone_ap_southeast_2a: 7_800,
      balancer_active_connections_by_zone_ap_southeast_2b: null,
    });
  });
});

describe('the load balancer’s capacity', () => {
  it('shows the share of its capacity used, the units it needed, and the units reserved', () => {
    const series = (name: string, statistic: string, value: number) =>
      seriesWith({
        namespace: 'AWS/ApplicationELB',
        name,
        statistic,
        dimensions: { LoadBalancer: 'app/lb/1' },
        points: [{ at: minute(0), value }],
      });
    const columns = awsColumns(
      runDataWith({
        awsMetrics: [
          resource('load-balancer', [
            series('CapacityUtilization', 'Maximum', 100),
            series('PeakLCUs', 'Maximum', 90),
            series('ReservedLCUs', 'Maximum', 140),
          ]),
        ],
      }),
    );
    const figures = Object.fromEntries(columns.map((column) => [column.name, column.at(MINUTE_0)]));

    expect(figures).toMatchObject({
      balancer_capacity_used_percent: 100,
      balancer_capacity_units_peak: 90,
      balancer_capacity_units_reserved: 140,
    });
  });
});

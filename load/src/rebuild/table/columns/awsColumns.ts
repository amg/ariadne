import {
  type MinuteCombine,
  SHARES,
  SIGNALS,
  type Share,
  type Signal,
} from '@ari/lib/metrics/catalogue';
import {
  AWS_METRIC_RESOURCES,
  INSIGHT_DIMENSIONS,
  LAYOUT,
  type MetricSeries,
} from '../../../records/index.ts';
import { minuteStartOf } from '../../moments.ts';
import { compareText, maxOf, percentOrNull } from '../../numbers.ts';
import type { Cell, ResourceMetrics, RunData } from '../../types.ts';
import { serviceLabelOrNull, targetGroupLabelsOf } from '../awsNames.ts';
import { type Column, splitName } from './minutes.ts';

/** Which series of a resource's CloudWatch metrics make one figure. */
type AwsQuery = Pick<Signal, 'namespace' | 'name' | 'statistic' | 'dimensions' | 'where'>;

/** The unit a figure is shown in: what its points are multiplied by, and the decimal places it keeps. */
type Unit = { scale?: number; places?: number };

/** One figure of a resource's CloudWatch metrics, in the unit the report shows it in. */
type AwsFigure = Unit & { column: string; signal: Signal };

/** The series of a resource that a query names. */
export function seriesMatching(metrics: ResourceMetrics, query: AwsQuery): readonly MetricSeries[] {
  const wanted = [...query.dimensions].sort(compareText).join('|');
  return metrics.series.filter(
    (series) =>
      series.namespace === query.namespace &&
      series.name === query.name &&
      series.statistic === query.statistic &&
      Object.keys(series.dimensions).sort(compareText).join('|') === wanted &&
      Object.entries(query.where ?? {}).every(([name, value]) => series.dimensions[name] === value),
  );
}

/**
 * The figure of each minute that any of the series has a point in: the
 * points of that minute added up or the highest of them, times `scale`.
 * A minute with no point has no figure, so a silent stretch stays empty.
 */
export function perMinute(
  series: readonly MetricSeries[],
  combine: MinuteCombine,
  scale = 1,
): (minute: number) => Cell {
  const minutes = new Map<number, number[]>();
  for (const point of series.flatMap(({ points }) => points)) {
    const minute = minuteStartOf(Date.parse(point.at));
    const values = minutes.get(minute);
    if (values === undefined) minutes.set(minute, [point.value]);
    else values.push(point.value);
  }
  return (minute) => {
    const values = minutes.get(minute);
    if (values === undefined) return null;
    const combined =
      combine === 'sum' ? values.reduce((sum, value) => sum + value, 0) : maxOf(values);
    return combined === null ? null : combined * scale;
  };
}

const RESOURCES = AWS_METRIC_RESOURCES;
const BYTES_PER_GIB = 1024 ** 3;
const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;

const figure = (column: string, signal: Signal, unit: Unit = {}) => ({
  column,
  signal,
  ...unit,
});

/**
 * The columns of the load balancer's answers that count what the
 * generators' lines count: every answer it gave, and its server and client
 * errors, each the sum of the columns named. An error comes either from a
 * service or from the load balancer itself.
 */
export const BALANCER_ANSWERS = {
  all: 'balancer_answered',
  serverErrors: ['balancer_app_5xx', 'balancer_5xx'],
  clientErrors: ['balancer_app_4xx', 'balancer_4xx'],
} as const;

/**
 * The metrics whose sum is every answer the load balancer gave: those that
 * came from a service, and those it gave itself, as when no service could
 * take the request.
 */
const ANSWERED: readonly Signal[] = [
  SIGNALS.loadBalancer.answeredByServiceWith2xx,
  SIGNALS.loadBalancer.answeredByServiceWith3xx,
  SIGNALS.loadBalancer.answeredByServiceWith4xx,
  SIGNALS.loadBalancer.answeredByServiceWith5xx,
  SIGNALS.loadBalancer.answeredItselfWith3xx,
  SIGNALS.loadBalancer.answeredItselfWith4xx,
  SIGNALS.loadBalancer.answeredItselfWith5xx,
];

/** Every answer the load balancer gave in each minute; null for a minute none of its counts has a point in. */
function balancerAnswered(balancer: ResourceMetrics): Column {
  const counts = ANSWERED.map((signal) =>
    perMinute(seriesMatching(balancer, signal), signal.minute),
  );
  return {
    name: BALANCER_ANSWERS.all,
    at: (minute) => {
      const values = counts.map((count) => count(minute));
      if (values.every((value) => value === null)) return null;
      return values.reduce<number>((total, value) => total + (value ?? 0), 0);
    },
  };
}

const [APP_5XX, BALANCER_5XX] = BALANCER_ANSWERS.serverErrors;
const [APP_4XX, BALANCER_4XX] = BALANCER_ANSWERS.clientErrors;

const LB = SIGNALS.loadBalancer;
const DB = SIGNALS.database;
const CACHE = SIGNALS.cache;

/** The figures of each resource that one file holds, by the resource they belong to. */
const FIGURES: Readonly<Record<string, readonly AwsFigure[]>> = {
  [RESOURCES.loadBalancer]: [
    figure('balancer_requests', LB.requests),
    figure(APP_5XX, LB.answeredByServiceWith5xx),
    figure(APP_4XX, LB.answeredByServiceWith4xx),
    figure(BALANCER_5XX, LB.answeredItselfWith5xx),
    figure(BALANCER_4XX, LB.answeredItselfWith4xx),
    figure('balancer_response_average_ms', LB.responseTimeAverage, {
      scale: MS_PER_SECOND,
      places: 1,
    }),
    figure('balancer_response_slowest_ms', LB.responseTimeSlowest, {
      scale: MS_PER_SECOND,
      places: 1,
    }),
    figure('balancer_new_connections', LB.newConnections),
    figure('balancer_active_connections', LB.activeConnections),
    figure('balancer_client_tls_errors', LB.clientTlsErrors),
    figure('balancer_target_tls_errors', LB.targetTlsErrors),
    figure('balancer_capacity_used_percent', LB.capacityUsed),
    figure('balancer_capacity_units_peak', LB.capacityUnitsPeak),
    figure('balancer_capacity_units_reserved', LB.capacityUnitsReserved),
  ],
  [RESOURCES.fargateUsage]: [
    figure('fargate_on_demand_vcpu', SIGNALS.fargateUsage.onDemandVcpu),
    figure('fargate_spot_vcpu', SIGNALS.fargateUsage.spotVcpu),
  ],
  [RESOURCES.database]: [
    figure('rds_cpu_percent', DB.cpu),
    figure('rds_sessions_on_cpu', DB.sessionsOnCpu, { places: 2 }),
    figure('rds_sessions_waiting', DB.sessionsWaiting, { places: 2 }),
    figure('rds_connections_max', DB.connections),
    figure('rds_free_storage_gib', DB.freeStorage, { scale: 1 / BYTES_PER_GIB, places: 2 }),
    figure('rds_read_iops', DB.readIops),
    figure('rds_write_iops', DB.writeIops),
    figure('rds_read_latency_ms', DB.readLatency, { scale: MS_PER_SECOND, places: 2 }),
    figure('rds_write_latency_ms', DB.writeLatency, { scale: MS_PER_SECOND, places: 2 }),
  ],
  [RESOURCES.cache]: [
    figure('cache_reads', CACHE.reads),
    figure('cache_writes', CACHE.writes),
    figure('cache_commands', CACHE.commands),
    figure('cache_ecpu_per_second', CACHE.processingUnits, { scale: 1 / SECONDS_PER_MINUTE }),
    figure('cache_throttled', CACHE.throttled),
    figure('cache_read_latency_ms', CACHE.readLatency, { scale: 1 / MS_PER_SECOND, places: 2 }),
    figure('cache_write_latency_ms', CACHE.writeLatency, { scale: 1 / MS_PER_SECOND, places: 2 }),
  ],
};

/** The figures every service's file holds, each split into one column per service. */
const SERVICE_FIGURES: readonly AwsFigure[] = [
  figure('ecs_running_tasks', SIGNALS.service.runningTasks),
  figure('ecs_desired_tasks', SIGNALS.service.desiredTasks),
  figure('ecs_pending_tasks', SIGNALS.service.pendingTasks),
  figure('service_cpu_average_percent', SIGNALS.service.cpuAverage),
  figure('service_cpu_busiest_percent', SIGNALS.service.cpuBusiest),
  figure('service_memory_average_percent', SIGNALS.service.memoryAverage),
];

/** The figures every target group's file holds, each split into one column per group. */
const TARGET_GROUP_FIGURES: readonly AwsFigure[] = [
  figure('target_group_requests', SIGNALS.targetGroup.requests),
  figure('target_group_healthy', SIGNALS.targetGroup.healthyHosts),
  figure('target_group_unhealthy', SIGNALS.targetGroup.unhealthyHosts),
];

function columnOf(metrics: ResourceMetrics, figure: AwsFigure): Column {
  return {
    name: figure.column,
    at: perMinute(seriesMatching(metrics, figure.signal), figure.signal.minute, figure.scale),
    ...(figure.places === undefined ? {} : { places: figure.places }),
  };
}

function splitColumnOf(metrics: ResourceMetrics, figure: AwsFigure, value: string): Column {
  return {
    ...columnOf(metrics, figure),
    name: splitName(figure.column, value),
    of: { figure: figure.column, value, source: metrics.path },
  };
}

/** A generator figure, by minute. */
function generatorPart(cluster: ResourceMetrics, signal: Signal) {
  return perMinute(seriesMatching(cluster, signal), signal.minute);
}

/** What the generators' tasks used of what they reserved, as a percent. */
function generatorShare(column: string, share: Share, data: RunData): Column[] {
  const cluster = data.awsMetrics.find(({ resource }) => resource === RESOURCES.generatorCluster);
  if (cluster === undefined) return [];
  const part = generatorPart(cluster, share.part);
  const whole = generatorPart(cluster, share.whole);
  return [{ name: column, at: (minute) => percentOrNull(part(minute), whole(minute)) }];
}

/** The name of the column of the busiest generator's CPU. */
export const BUSIEST_GENERATOR_CPU = 'generators_cpu_busiest_percent';

/**
 * The busiest generator's CPU as a percent of what each generator reserves;
 * no column when the run kept no metrics of the generators. Every generator
 * reserves the same, so one reservation is the whole of it.
 */
export function busiestGeneratorCpu(data: RunData): Column[] {
  return generatorShare(BUSIEST_GENERATOR_CPU, SHARES.generatorCpuBusiest, data);
}

/** The load balancer's figures that are shown zone by zone. */
const ZONE_FIGURES: readonly AwsFigure[] = [
  figure('balancer_requests_by_zone', SIGNALS.loadBalancerByZone.requests),
  figure('balancer_new_connections_by_zone', SIGNALS.loadBalancerByZone.newConnections),
  figure('balancer_active_connections_by_zone', SIGNALS.loadBalancerByZone.activeConnections),
];

const ZONE = 'AvailabilityZone';

/** The load balancer's connections and requests, split by availability zone. */
function zoneColumns(balancer: ResourceMetrics): Column[] {
  const zones = [
    ...new Set(balancer.series.flatMap((series) => series.dimensions[ZONE] ?? [])),
  ].sort(compareText);
  return ZONE_FIGURES.flatMap(({ column, signal }) =>
    zones.map((zone) => ({
      name: splitName(column, zone),
      of: { figure: column, value: zone, source: balancer.path },
      at: perMinute(
        seriesMatching(balancer, { ...signal, where: { ...signal.where, [ZONE]: zone } }),
        signal.minute,
      ),
    })),
  );
}

/** Every figure of the CloudWatch metrics the run kept, in the unit the report shows it in. */
export function awsColumns(data: RunData): Column[] {
  const files = [...data.awsMetrics].sort((a, b) => compareText(a.resource, b.resource));
  const targetGroups = targetGroupLabelsOf(data);
  const split = (
    figures: readonly AwsFigure[],
    labelOf: (resource: string) => string | null,
  ): Column[] =>
    figures.flatMap((figure) =>
      files.flatMap((metrics) => {
        const label = labelOf(metrics.resource);
        return label === null ? [] : [splitColumnOf(metrics, figure, label)];
      }),
    );
  const balancer = files.find(({ resource }) => resource === RESOURCES.loadBalancer);
  return [
    ...files.flatMap((metrics) =>
      (FIGURES[metrics.resource] ?? []).map((figure) => columnOf(metrics, figure)),
    ),
    ...(balancer === undefined ? [] : [balancerAnswered(balancer), ...zoneColumns(balancer)]),
    ...generatorShare('generators_cpu_percent', SHARES.generatorCpuTotal, data),
    ...busiestGeneratorCpu(data),
    ...generatorShare('generators_memory_percent', SHARES.generatorMemoryTotal, data),
    ...split(SERVICE_FIGURES, serviceLabelOrNull),
    ...split(TARGET_GROUP_FIGURES, (resource) => targetGroups.get(resource) ?? null),
  ];
}

/** How many sessions each of the database's busiest waits held, from Performance Insights. */
export function waitColumns(data: RunData): Column[] {
  const waitName = INSIGHT_DIMENSIONS.waitName;
  const waits = (data.insights ?? []).filter((insight) => insight.group === 'wait');
  const names = [...new Set(waits.flatMap((insight) => insight.dimensions[waitName] ?? []))].sort(
    compareText,
  );
  return names.map((name) => {
    const own = new Map(
      waits
        .filter((insight) => insight.dimensions[waitName] === name)
        .map((insight) => [minuteStartOf(Date.parse(insight.at)), insight.averageActiveSessions]),
    );
    return {
      name: splitName('db_wait', name),
      places: 2,
      of: { figure: 'db_wait', value: name, source: LAYOUT.insights },
      at: (minute: number) => own.get(minute) ?? null,
    };
  });
}

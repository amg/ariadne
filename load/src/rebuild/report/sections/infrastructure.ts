import { AWS_METRIC_RESOURCES, LAYOUT } from '../../../records/index.ts';
import {
  type Builder,
  GENERATOR_REQUESTS,
  type Section,
  anyOf,
  inAwsMetrics,
  inFile,
} from '../builder.ts';

const BALANCER = inAwsMetrics(AWS_METRIC_RESOURCES.loadBalancer);
const DATABASE = inAwsMetrics(AWS_METRIC_RESOURCES.database);
const CACHE = inAwsMetrics(AWS_METRIC_RESOURCES.cache);
const FARGATE = inAwsMetrics(AWS_METRIC_RESOURCES.fargateUsage);
/** CPU per job is drawn from the workers' metrics and the job lines. */
const WORKER_PER_JOB = anyOf(
  inAwsMetrics(AWS_METRIC_RESOURCES.service('worker')),
  inFile(LAYOUT.jobs),
);
const DATABASE_PER_JOB = anyOf(DATABASE, inFile(LAYOUT.jobs));

export function tasksSection({ split, chart }: Builder): Section {
  return {
    heading: 'How many tasks run',
    charts: [
      chart('Running tasks', 'tasks', split('ecs_running_tasks')),
      chart('Desired tasks', 'tasks', split('ecs_desired_tasks')),
      chart('Pending tasks', 'tasks', split('ecs_pending_tasks')),
    ],
    tables: [],
  };
}

/** The dashboard draws the vCPU in use against its quota. A run does not keep the quota, so only what was in use is drawn. */
export function fargateSection({ line, chart }: Builder): Section {
  return {
    heading: 'Fargate vCPU in use',
    charts: [
      chart('On-Demand vCPU, the app', 'vCPU', [line('in use', 'fargate_on_demand_vcpu', FARGATE)]),
      chart('Spot vCPU, the generators', 'vCPU', [line('in use', 'fargate_spot_vcpu', FARGATE)]),
    ],
    tables: [],
  };
}

export function balancerSection({ line, chart }: Builder): Section {
  return {
    heading: 'Traffic at the load balancer',
    charts: [
      chart('Requests', 'per minute', [line('requests', 'balancer_requests', BALANCER)]),
      chart('How long the services took to start answering', 'ms', [
        line('average', 'balancer_response_average_ms', BALANCER),
        line('slowest', 'balancer_response_slowest_ms', BALANCER),
      ]),
      chart('Errors', 'per minute', [
        line('app 5xx', 'balancer_app_5xx', BALANCER),
        line('app 4xx', 'balancer_app_4xx', BALANCER),
        line('balancer 5xx', 'balancer_5xx', BALANCER),
        line('balancer 4xx', 'balancer_4xx', BALANCER),
      ]),
    ],
    tables: [],
  };
}

/** What became of the generators' push streams: those opened, and those that ended before their users let them go. */
export function pushStreamsSection({ line, split, chart }: Builder): Section {
  return {
    heading: 'Push streams that ended early',
    charts: [
      chart('Push streams opened', 'per minute', [
        line('opened', 'push_streams_opened', GENERATOR_REQUESTS),
      ]),
      chart('Push streams that ended before their users let them go', 'per minute', [
        line('ended early', 'push_streams_ended_early', GENERATOR_REQUESTS),
        line('cut off', 'push_streams_cut', GENERATOR_REQUESTS),
        line('opened again within seconds', 'push_streams_reopened', GENERATOR_REQUESTS),
      ]),
      chart(
        'How long the streams that ended early had lasted',
        'streams per minute',
        split('push_streams_ended_lasted'),
      ),
    ],
    tables: [],
  };
}

export function connectionsSection({ line, split, chart }: Builder): Section {
  const newByZone = split('balancer_new_connections_by_zone');
  return {
    heading: 'Load balancer connections',
    charts: [
      chart(
        'Active connections, by zone',
        'per minute',
        split('balancer_active_connections_by_zone'),
      ),
      // Each push stream holds a connection of its own, so the streams the generators opened stand for their new connections.
      ...(newByZone.length === 0
        ? []
        : [
            chart('New connections by zone, beside the push streams opened', 'per minute', [
              ...newByZone,
              line('push streams the generators opened', 'push_streams_opened', GENERATOR_REQUESTS),
            ]),
          ]),
      chart('Connections', 'per minute', [
        line('new connections', 'balancer_new_connections', BALANCER),
        line('active connections', 'balancer_active_connections', BALANCER),
      ]),
      chart('Capacity', 'capacity units; it grows itself as the share used nears 100%', [
        line('most needed in the minute', 'balancer_capacity_units_peak', BALANCER),
        line('reserved', 'balancer_capacity_units_reserved', BALANCER),
      ]),
      chart('Share of its capacity used', '%', [
        line('used', 'balancer_capacity_used_percent', BALANCER),
      ]),
      chart('TLS errors', 'per minute', [
        line('client TLS errors', 'balancer_client_tls_errors', BALANCER),
        line('target TLS errors', 'balancer_target_tls_errors', BALANCER),
      ]),
    ],
    tables: [],
  };
}

export function servicesSection({ line, split, chart }: Builder): Section {
  return {
    heading: 'The services',
    charts: [
      chart('CPU, average task', '%', split('service_cpu_average_percent')),
      chart('CPU, busiest task', '%', split('service_cpu_busiest_percent')),
      chart('Memory, average task', '%', split('service_memory_average_percent')),
      chart(
        'CPU for each job started',
        'ms of CPU per job; rising on a steady load means more work per job',
        [
          line('workers', 'worker_cpu_ms_per_job', WORKER_PER_JOB),
          line('database', 'db_cpu_ms_per_job', DATABASE_PER_JOB),
        ],
      ),
      chart('How long jobs ran, by task', 'ms on average', split('job_run_mean_ms')),
      chart('Jobs started, by task', 'per minute', split('jobs_started')),
    ],
    tables: [],
  };
}

export function databaseSection({ line, chart }: Builder): Section {
  return {
    heading: 'The database',
    charts: [
      chart('CPU', '%', [line('busiest minute', 'rds_cpu_percent', DATABASE)]),
      chart('Sessions busy at once', 'sessions; above the vCPU count means queueing', [
        line('on CPU', 'rds_sessions_on_cpu', DATABASE),
        line('waiting', 'rds_sessions_waiting', DATABASE),
      ]),
      chart('Connections', 'connections', [
        line('most in the minute', 'rds_connections_max', DATABASE),
      ]),
    ],
    tables: [],
  };
}

export function diskSection({ line, chart }: Builder): Section {
  return {
    heading: "The database's disk",
    charts: [
      chart('Free storage', 'GiB', [line('free space', 'rds_free_storage_gib', DATABASE)]),
      chart('IOPS', 'operations per second', [
        line('read', 'rds_read_iops', DATABASE),
        line('write', 'rds_write_iops', DATABASE),
      ]),
      chart('Disk latency', 'ms', [
        line('read', 'rds_read_latency_ms', DATABASE),
        line('write', 'rds_write_latency_ms', DATABASE),
      ]),
    ],
    tables: [],
  };
}

export function cacheSection({ facts, line, chart }: Builder): Section {
  const cap = facts.run.cacheEcpuCap;
  return {
    heading: 'The cache',
    charts: [
      chart('Commands', 'per minute', [
        line('reads', 'cache_reads', CACHE),
        line('writes', 'cache_writes', CACHE),
        line('all commands', 'cache_commands', CACHE),
      ]),
      chart(
        'ECPU consumed',
        'per second',
        [line('ECPU', 'cache_ecpu_per_second', CACHE)],
        cap === null ? null : { label: `cap ${cap} a second`, value: cap },
      ),
      chart('Requests throttled, and latency', 'commands per minute; ms', [
        line('throttled commands', 'cache_throttled', CACHE),
        line('read latency', 'cache_read_latency_ms', CACHE),
        line('write latency', 'cache_write_latency_ms', CACHE),
      ]),
    ],
    tables: [],
  };
}

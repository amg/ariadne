import { describe, expect, it } from 'vitest';
import type { JobLine, MetricSeries } from '../../../records/index.ts';
import { MINUTE_MS } from '../../moments.ts';
import { STARTED, at, manifestWith, runDataWith } from '../../runData/testing.ts';
import { cpuPerJobColumns, databaseVcpuOrNull } from './cpuPerJobColumns.ts';

const MINUTE_0 = Date.parse(STARTED);

const series = (
  overrides: Pick<MetricSeries, 'namespace' | 'name' | 'statistic' | 'dimensions'>,
  value: number,
) => ({ periodSeconds: 60, points: [{ at: STARTED, value }], ...overrides });

const SERVICE = { ClusterName: 'app', ServiceName: 'worker-service' };

const jobsStarted = (count: number): JobLine[] =>
  Array.from({ length: count }, (_, index) => ({
    copy: 'worker-1',
    task: 'judge',
    jobId: String(index),
    attempt: 1,
    queuedAt: at(1),
    startedAt: at(1),
    finishedAt: at(2),
    durationMs: 50,
    outcome: 'succeeded',
    errorClass: null,
    errorCode: null,
  }));

const sizedRun = (config: Record<string, unknown>) =>
  runDataWith({
    manifest: manifestWith({ config }),
    jobs: jobsStarted(6_000),
    awsMetrics: [
      {
        resource: 'ecs-service-worker',
        path: 'metrics/aws/ecs-service-worker.jsonl',
        series: [
          series(
            {
              namespace: 'AWS/ECS',
              name: 'CPUUtilization',
              statistic: 'Average',
              dimensions: SERVICE,
            },
            50,
          ),
          series(
            {
              namespace: 'ECS/ContainerInsights',
              name: 'RunningTaskCount',
              statistic: 'Average',
              dimensions: SERVICE,
            },
            8,
          ),
        ],
      },
      {
        resource: 'database',
        path: 'metrics/aws/database.jsonl',
        series: [
          series(
            {
              namespace: 'AWS/RDS',
              name: 'CPUUtilization',
              statistic: 'Maximum',
              dimensions: { DBInstanceIdentifier: 'db' },
            },
            60,
          ),
        ],
      },
    ],
  });

describe('cpuPerJobColumns', () => {
  it('spreads the CPU time of the workers and of the database over the jobs that started', () => {
    const figures = Object.fromEntries(
      cpuPerJobColumns(
        sizedRun({
          services: { worker: { cpu: 1024 } },
          database: { instanceClass: 'm7g.xlarge' },
        }),
      ).map((column) => [column.name, column.at(MINUTE_0)]),
    );

    // Half of eight one-vCPU tasks for a minute, and 60% of four vCPU, over 6,000 jobs.
    expect(figures).toEqual({
      worker_cpu_ms_per_job: (0.5 * 8 * MINUTE_MS) / 6_000,
      db_cpu_ms_per_job: (0.6 * 4 * MINUTE_MS) / 6_000,
    });
  });

  it('has no figure for a minute in which no job started', () => {
    const [worker] = cpuPerJobColumns(sizedRun({ services: { worker: { cpu: 1024 } } }));
    expect(worker?.at(MINUTE_0 + MINUTE_MS)).toBeNull();
  });

  it('has no column where the step does not say how big the tasks or the database are', () => {
    expect(cpuPerJobColumns(sizedRun({}))).toEqual([]);
  });
});

describe('databaseVcpuOrNull', () => {
  it('reads the vCPU of an instance class from its size', () => {
    expect(databaseVcpuOrNull('m7g.large')).toBe(2);
    expect(databaseVcpuOrNull('m7g.xlarge')).toBe(4);
    expect(databaseVcpuOrNull('r7g.4xlarge')).toBe(16);
    expect(databaseVcpuOrNull('t4g.micro')).toBeNull();
  });
});

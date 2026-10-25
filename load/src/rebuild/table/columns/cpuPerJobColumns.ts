import { SIGNALS } from '@ari/lib/metrics/catalogue';
import { z } from 'zod';
import { AWS_METRIC_RESOURCES, type Manifest } from '../../../records/index.ts';
import { MINUTE_MS } from '../../moments.ts';
import type { Cell, RunData } from '../../types.ts';
import { perMinute, seriesMatching } from './awsColumns.ts';
import { type Column, byMinute } from './minutes.ts';

/** What ECS counts a vCPU as, in a task's CPU units. */
const CPU_UNITS_PER_VCPU = 1024;

const sizedConfig = z.object({
  services: z.object({ worker: z.object({ cpu: z.number() }) }).optional(),
  database: z.object({ instanceClass: z.string() }).optional(),
});

/** The vCPU of a database instance class by its size, such as 4 for `m7g.xlarge`; null for a size not known here. */
export function databaseVcpuOrNull(instanceClass: string) {
  const size = instanceClass.split('.').at(-1) ?? '';
  if (size === 'large') return 2;
  if (size === 'xlarge') return 4;
  const multiple = /^(\d+)xlarge$/.exec(size)?.[1];
  return multiple === undefined ? null : Number(multiple) * 4;
}

/** The vCPU one worker task has, and the database has, as the run's step recorded them; null where it does not say. */
function vcpuOf(manifest: Pick<Manifest, 'config'>) {
  const parsed = sizedConfig.safeParse(manifest.config);
  if (!parsed.success) return { worker: null, database: null };
  const { services, database } = parsed.data;
  return {
    worker: services === undefined ? null : services.worker.cpu / CPU_UNITS_PER_VCPU,
    database: database === undefined ? null : databaseVcpuOrNull(database.instanceClass),
  };
}

/** The CPU a minute used, in milliseconds, for each job that started in it; null where either is unknown or no job started. */
function perJob(
  cpuMs: (minute: number) => Cell,
  jobs: (minute: number) => number,
): (minute: number) => Cell {
  return (minute) => {
    const used = cpuMs(minute);
    const started = jobs(minute);
    return used === null || started === 0 ? null : used / started;
  };
}

/**
 * The CPU time the workers, and the database, spent in each minute for
 * each job that started in it, in milliseconds. The database's CPU is all
 * of its work, the API's included, set against the jobs alone. No column
 * where the run kept no such metrics, or its step does not say how big
 * the tasks or the database are.
 */
export function cpuPerJobColumns(data: RunData): Column[] {
  if (data.jobs === null) return [];
  const started = byMinute(data.jobs, (job) => job.startedAt);
  const jobs = (minute: number) => started.get(minute)?.length ?? 0;
  const vcpu = vcpuOf(data.manifest);
  const resource = (name: string) => data.awsMetrics.find(({ resource: own }) => own === name);
  const columns: Column[] = [];

  const worker = resource(AWS_METRIC_RESOURCES.service('worker'));
  if (worker !== undefined && vcpu.worker !== null) {
    const perTask = vcpu.worker;
    const share = perMinute(seriesMatching(worker, SIGNALS.service.cpuAverage), 'max');
    const tasks = perMinute(seriesMatching(worker, SIGNALS.service.runningTasks), 'max');
    columns.push({
      name: 'worker_cpu_ms_per_job',
      at: perJob((minute) => {
        const percent = share(minute);
        const running = tasks(minute);
        if (percent === null || running === null) return null;
        return (percent / 100) * running * perTask * MINUTE_MS;
      }, jobs),
    });
  }

  const database = resource(AWS_METRIC_RESOURCES.database);
  if (database !== undefined && vcpu.database !== null) {
    const cores = vcpu.database;
    const percent = perMinute(seriesMatching(database, SIGNALS.database.cpu), 'max');
    columns.push({
      name: 'db_cpu_ms_per_job',
      at: perJob((minute) => {
        const used = percent(minute);
        return used === null ? null : (used / 100) * cores * MINUTE_MS;
      }, jobs),
    });
  }
  return columns;
}

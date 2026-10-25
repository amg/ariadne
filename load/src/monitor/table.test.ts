import { describe, expect, it } from 'vitest';
import type { Series } from './series.ts';
import { monitorTable } from './table.ts';

const minute = (n: number) => new Date(Date.UTC(2026, 9, 15, 3, n));
const series = (label: string, values: Record<number, number>): Series => ({
  label,
  points: Object.entries(values).map(([n, value]) => ({ at: minute(Number(n)), value })),
});
const API = 'ServicesApiService1-x';
const WORKER = 'ServicesWorkerService2-y';

/** The text of one column's cells, by its header. */
function column(table: ReturnType<typeof monitorTable>, header: string) {
  const index = table.headers.indexOf(header);
  return table.rows.map((row) => row[index]?.text ?? '?');
}
function levels(table: ReturnType<typeof monitorTable>, header: string): string[] {
  const index = table.headers.indexOf(header);
  return table.rows.map((row) => row[index]?.level ?? '?');
}

describe('monitorTable', () => {
  it('adds up the users of every generator for each minute', () => {
    const table = monitorTable([
      series('users', { 0: 1_000, 1: 1_500 }),
      series('users', { 0: 2_000, 1: 2_500 }),
    ]);

    expect(column(table, 'users')).toEqual(['3000', '4000']);
  });

  it('shows the chat first byte in seconds and highlights it past its pass line', () => {
    const table = monitorTable([series('chat_p95', { 0: 1_200, 1: 2_100, 2: 2_500, 3: 2_510 })]);

    expect(column(table, 'chat_p95_s')).toEqual(['1.2', '2.1', '2.5', '2.51']);
    expect(levels(table, 'chat_p95_s')).toEqual(['none', 'warn', 'warn', 'alert']);
  });

  it('shows the tasks each service runs of those it wants, warning while fewer run', () => {
    const table = monitorTable([
      series(`running ${API}`, { 0: 4, 1: 3.25 }),
      series(`desired ${API}`, { 0: 4, 1: 5 }),
      series(`running ${WORKER}`, { 0: 2 }),
    ]);

    expect(column(table, 'tasks_api')).toEqual(['4/4', '3.3/5']);
    expect(levels(table, 'tasks_api')).toEqual(['none', 'warn']);
    expect(column(table, 'tasks_worker')).toEqual(['2/-', '-']);
    expect(levels(table, 'tasks_worker')).toEqual(['none', 'none']);
  });

  it('orders the services as they are met, others after, and groups tasks before CPU', () => {
    const table = monitorTable([
      series('cpu Zebra', { 0: 1 }),
      series(`cpu ${WORKER}`, { 0: 1 }),
      series(`cpu ${API}`, { 0: 1 }),
      series('running Zebra', { 0: 1 }),
    ]);

    expect(table.headers).toEqual([
      'time',
      'users',
      'chat_p95_s',
      'tasks_api',
      'tasks_worker',
      'tasks_zebra',
      'cpu%_api',
      'cpu%_worker',
      'cpu%_zebra',
      'db_cpu%',
      'db_load',
      'req/min',
      'alb_p95_s',
    ]);
  });

  it('highlights a service’s CPU past 50% and past 80%, as it is shown', () => {
    const table = monitorTable([series(`cpu ${API}`, { 0: 49.96, 1: 50.4, 2: 80.4 })]);

    expect(column(table, 'cpu%_api')).toEqual(['50', '50.4', '80.4']);
    expect(levels(table, 'cpu%_api')).toEqual(['none', 'warn', 'alert']);
  });

  it('adds up the requests and rounds the load balancer’s response time to a hundredth', () => {
    const table = monitorTable([
      series('requests', { 0: 100.4 }),
      series('requests', { 0: 50 }),
      series('alb_p95', { 0: 0.5249, 1: 2.4 }),
    ]);

    expect(column(table, 'req/min')).toEqual(['150', '-']);
    expect(column(table, 'alb_p95_s')).toEqual(['0.52', '2.4']);
    expect(levels(table, 'alb_p95_s')).toEqual(['warn', 'alert']);
  });

  it('shows a dash for a figure a minute lacks, and a row for each minute any series has, oldest first', () => {
    const table = monitorTable([series('db_cpu', { 2: 40 }), series('db_load', { 0: 1.26 })]);

    expect(column(table, 'time')).toEqual(['03:00', '03:02']);
    expect(column(table, 'db_cpu%')).toEqual(['-', '40']);
    expect(column(table, 'db_load')).toEqual(['1.3', '-']);
  });

  it('adds no column for the series names CloudWatch puts after a measure', () => {
    const table = monitorTable([
      series(`cpu ${API}`, { 0: 10 }),
      series('requests AWS/ApplicationELB app/origin-a/1 RequestCount', { 0: 100 }),
      series('requests AWS/ApplicationELB app/origin-b/2 RequestCount', { 0: 20 }),
      series('db_cpu AWS/RDS app-db CPUUtilization', { 0: 35 }),
    ]);

    expect(table.headers.filter((header) => header.startsWith('cpu%_'))).toEqual(['cpu%_api']);
    expect(table.headers.filter((header) => header.startsWith('tasks_'))).toEqual(['tasks_api']);
    expect(column(table, 'req/min')).toEqual(['120']);
    expect(column(table, 'db_cpu%')).toEqual(['35']);
  });

  it('ignores a series it did not ask for', () => {
    expect(monitorTable([series('mystery', { 0: 1 })]).rows).toEqual([]);
  });
});

import { type Level, balancerP95Level, chatP95Level, cpuLevel, tasksLevel } from './highlight.ts';
import { type Measure, measureOrNull, minuteCombineOf } from './queries.ts';
import type { Series } from './series.ts';

/** One figure of the table as text, with how far it has gone toward a limit. */
type Cell = { text: string; level: Level };

type MonitorTable = {
  headers: string[];
  /** One row per minute that any series has a point for, oldest first; the first cell is the minute, in UTC. */
  rows: Cell[][];
};

/** The order services read in, then any other by name. */
const SERVICE_ORDER = ['api', 'worker', 'auth', 'web', 'mock'];

const NO_DATA: Cell = { text: '-', level: 'none' };
const plain = (text: string): Cell => ({ text, level: 'none' });
const tenth = (value: number) => Math.round(value * 10) / 10;
const hundredth = (value: number) => Math.round(value * 100) / 100;

/** What one measure's value is shown as, and when it is highlighted. */
function cellOf(measure: Measure, value: number): Cell {
  switch (measure) {
    case 'chat_p95': {
      const seconds = hundredth(value / 1_000);
      return { text: String(seconds), level: chatP95Level(seconds) };
    }
    case 'alb_p95': {
      const seconds = hundredth(value);
      return { text: String(seconds), level: balancerP95Level(seconds) };
    }
    case 'cpu':
      return { text: String(tenth(value)), level: cpuLevel(tenth(value)) };
    case 'users':
    case 'requests':
      return plain(String(Math.round(value)));
    default:
      return plain(String(tenth(value)));
  }
}

/** What every series says at one minute, one figure for each measure and service. */
type Minute = ReadonlyMap<string, number>;

const keyOf = (measure: Measure, service: string | null) => `${measure}|${service ?? ''}`;

/** The minutes any series has a point at, with the figure of each measure and service at each. */
function minutesOf(series: readonly Series[]): Map<number, Minute> {
  const values = new Map<number, Map<string, { measure: Measure; seen: number[] }>>();
  for (const { label, points } of series) {
    const what = measureOrNull(label);
    if (what === null) continue;
    const key = keyOf(what.measure, what.service);
    for (const { at, value } of points) {
      const minute = values.get(at.getTime()) ?? new Map();
      const entry = minute.get(key) ?? { measure: what.measure, seen: [] };
      entry.seen.push(value);
      minute.set(key, entry);
      values.set(at.getTime(), minute);
    }
  }
  return new Map(
    [...values].map(([at, minute]) => [
      at,
      new Map(
        [...minute].map(([key, { measure, seen }]) => [
          key,
          minuteCombineOf(measure) === 'sum'
            ? seen.reduce((sum, value) => sum + value, 0)
            : Math.max(...seen),
        ]),
      ),
    ]),
  );
}

function servicesIn(series: readonly Series[]) {
  const seen = new Set<string>();
  for (const { label } of series) {
    const service = measureOrNull(label)?.service;
    if (service !== null && service !== undefined) seen.add(service);
  }
  const rank = (service: string): number => {
    const index = SERVICE_ORDER.indexOf(service);
    return index === -1 ? SERVICE_ORDER.length : index;
  };
  return [...seen].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

type Column = { header: string; cell: (minute: Minute) => Cell };

/** A column of one measure, for one service when it has one. */
function figureColumn(header: string, measure: Measure, service: string | null = null): Column {
  return {
    header,
    cell(minute) {
      const value = minute.get(keyOf(measure, service));
      return value === undefined ? NO_DATA : cellOf(measure, value);
    },
  };
}

/** The tasks a service runs of those it wants, such as `3/4`; a warning while fewer run than are wanted. */
function tasksColumn(service: string): Column {
  const count = (value: number | undefined): string =>
    value === undefined ? '-' : String(tenth(value));
  return {
    header: `tasks_${service}`,
    cell(minute) {
      const running = minute.get(keyOf('running', service));
      const desired = minute.get(keyOf('desired', service));
      if (running === undefined && desired === undefined) return NO_DATA;
      const level =
        running === undefined || desired === undefined ? 'none' : tasksLevel(running, desired);
      return { text: `${count(running)}/${count(desired)}`, level };
    },
  };
}

/**
 * The table `monitor` shows: a row per minute with the users online, the
 * chat first byte at its 95th percentile, how many tasks each service runs
 * of those it wants, each service's CPU, the database, and the load
 * balancer. A minute that has no point for a figure shows a dash.
 */
export function monitorTable(series: readonly Series[]): MonitorTable {
  const services = servicesIn(series);
  const columns: Column[] = [
    figureColumn('users', 'users'),
    figureColumn('chat_p95_s', 'chat_p95'),
    ...services.map(tasksColumn),
    ...services.map((service) => figureColumn(`cpu%_${service}`, 'cpu', service)),
    figureColumn('db_cpu%', 'db_cpu'),
    figureColumn('db_load', 'db_load'),
    figureColumn('req/min', 'requests'),
    figureColumn('alb_p95_s', 'alb_p95'),
  ];
  const minutes = minutesOf(series);
  return {
    headers: ['time', ...columns.map((column) => column.header)],
    rows: [...minutes.keys()]
      .sort((a, b) => a - b)
      .map((at) => {
        const minute = minutes.get(at) ?? new Map();
        const time = plain(new Date(at).toISOString().slice(11, 16));
        return [time, ...columns.map((column) => column.cell(minute))];
      }),
  };
}

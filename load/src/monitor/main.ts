import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { fetchSeries } from './cloudwatch.ts';
import type { MonitorScope } from './queries.ts';
import { monitorText } from './render.ts';

/** How far back the table reaches. */
const MINUTES = 15;

/** An environment variable's value; undefined when it is unset or empty. */
const settingOrUndefined = (name: string) => process.env[name] || undefined;

/**
 * Prints the last quarter hour of a raise as one table, a row a minute:
 *   npm run monitor --workspace=load
 * Every figure is worked out here from what CloudWatch holds. The ones past a
 * limit are in colour on a terminal, or wherever MONITOR_COLOUR is 1, unless
 * NO_COLOR is set. MONITOR_CLUSTER, MONITOR_LOAD_BALANCER and MONITOR_DATABASE
 * narrow the figures to one stack's resources.
 */
const to = new Date();
const from = new Date(to.getTime() - MINUTES * 60_000);
const scope: MonitorScope = {
  cluster: settingOrUndefined('MONITOR_CLUSTER'),
  loadBalancer: settingOrUndefined('MONITOR_LOAD_BALANCER'),
  database: settingOrUndefined('MONITOR_DATABASE'),
};
const series = await fetchSeries(new CloudWatchClient({}), { from, to }, scope);
const colour =
  settingOrUndefined('NO_COLOR') === undefined &&
  (process.stdout.isTTY || settingOrUndefined('MONITOR_COLOUR') === '1');
console.log(monitorText(series, colour));

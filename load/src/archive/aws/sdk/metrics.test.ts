import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
  type Metric,
} from '@aws-sdk/client-cloudwatch';
import { describe, expect, it } from 'vitest';
import { metricTargetsOf } from '../raise.ts';
import { RAISED, STARTED, raise } from '../testing.ts';
import { metricSources } from './metrics.ts';

const POINT_AT = new Date(STARTED);

/** A client that lists `metrics` and gives every query one point, without reaching AWS. */
function clientHolding(metrics: readonly Metric[]) {
  const client = new CloudWatchClient({ region: 'ap-southeast-2' });
  // Replaces the network call; the client's own paging still runs.
  client.send = (async (command: unknown) => {
    if (command instanceof ListMetricsCommand) {
      return { Metrics: metrics.filter((m) => m.Namespace === command.input.Namespace) };
    }
    if (command instanceof GetMetricDataCommand) {
      return {
        MetricDataResults: (command.input.MetricDataQueries ?? []).map((query) => ({
          Id: query.Id,
          Timestamps: [POINT_AT],
          Values: [1],
        })),
      };
    }
    throw new Error('unexpected command');
  }) as unknown as typeof client.send;
  return client;
}

describe('metricSources', () => {
  it('reads the series of a target described afresh from the same raise', async () => {
    const client = clientHolding([
      {
        Namespace: 'AWS/RDS',
        MetricName: 'CPUUtilization',
        Dimensions: [{ Name: 'DBInstanceIdentifier', Value: raise.database.identifier }],
      },
    ]);
    const sources = metricSources(client, metricTargetsOf(raise));
    const database = metricTargetsOf(raise).find((target) => target.label === 'database');
    if (database === undefined) throw new Error('the raise has no database target');

    const series = await sources.metricSeries(database, {
      from: new Date(RAISED),
      to: new Date(STARTED),
    });

    expect(series.map((one) => [one.name, one.statistic])).toContainEqual([
      'CPUUtilization',
      'Average',
    ]);
  });
});

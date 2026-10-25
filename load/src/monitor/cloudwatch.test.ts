import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { describe, expect, it } from 'vitest';
import { fetchSeries } from './cloudwatch.ts';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 15, 3, minute));

/** A client that answers each request with the next page, without reaching AWS. */
function clientAnswering(...pages: { MetricDataResults: object[]; NextToken?: string }[]) {
  let next = 0;
  const client = new CloudWatchClient({ region: 'ap-southeast-2' });
  // Replaces the network call; the client's own paging still runs.
  client.send = (async () => pages[next++]) as unknown as typeof client.send;
  return client;
}

describe('fetchSeries', () => {
  it('keeps each result as a series with its label, even when several share an id', async () => {
    const client = clientAnswering({
      MetricDataResults: [
        { Id: 'users', Label: 'users', Timestamps: [at(0), at(1)], Values: [10, 20] },
        { Id: 'users', Label: 'users', Timestamps: [at(0)], Values: [5] },
      ],
    });

    const series = await fetchSeries(client, { from: at(0), to: at(15) }, {});

    expect(series).toEqual([
      {
        label: 'users',
        points: [
          { at: at(0), value: 10 },
          { at: at(1), value: 20 },
        ],
      },
      { label: 'users', points: [{ at: at(0), value: 5 }] },
    ]);
  });

  it('reads on through every page', async () => {
    const client = clientAnswering(
      {
        MetricDataResults: [{ Id: 'a', Label: 'db_cpu', Timestamps: [at(0)], Values: [1] }],
        NextToken: 'more',
      },
      { MetricDataResults: [{ Id: 'a', Label: 'db_cpu', Timestamps: [at(1)], Values: [2] }] },
    );

    const series = await fetchSeries(client, { from: at(0), to: at(15) }, {});

    expect(series.flatMap((one) => one.points.map((point) => point.value))).toEqual([1, 2]);
  });

  it('drops a timestamp that has no value', async () => {
    const client = clientAnswering({
      MetricDataResults: [{ Id: 'a', Label: 'users', Timestamps: [at(0), at(1)], Values: [3] }],
    });

    const [only] = await fetchSeries(client, { from: at(0), to: at(15) }, {});

    expect(only?.points).toEqual([{ at: at(0), value: 3 }]);
  });
});

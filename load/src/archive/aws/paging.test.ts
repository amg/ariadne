import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTasksCommand, ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import { describe, expect, it } from 'vitest';
import { metricTargetsOf } from './raise.ts';
import { ecsSources } from './sdk/ecs.ts';
import { logSources } from './sdk/logs.ts';
import { metricSources } from './sdk/metrics.ts';
import { RAISED, STARTED, raise } from './testing.ts';

/**
 * Each AWS reader is given a client that answers from a script, a page at a
 * time, without reaching AWS. The client's own paging still runs.
 */
const REGION = { region: 'ap-southeast-2' };

const window = { from: new Date(RAISED), to: new Date('2026-10-15T00:20:00.000Z') };

describe('CloudWatch logs', () => {
  function logsClient(
    pages: readonly {
      events: { message: string; timestamp: number }[];
      next: string | undefined;
    }[],
  ) {
    const client = new CloudWatchLogsClient(REGION);
    const tokens: (string | undefined)[] = [];
    client.send = (async (command: unknown) => {
      if (!(command instanceof GetLogEventsCommand)) throw new Error('unexpected command');
      tokens.push(command.input.nextToken);
      const index = tokens.length - 1;
      const page = pages[Math.min(index, pages.length - 1)];
      return { events: page?.events ?? [], nextForwardToken: page?.next };
    }) as unknown as typeof client.send;
    return { client, tokens };
  }

  const event = (message: string) => ({ message, timestamp: Date.parse(STARTED) });

  it('reads every page of a stream, and stops when the stream gives the same token again', async () => {
    const { client, tokens } = logsClient([
      { events: [event('a'), event('b')], next: 'f/1' },
      { events: [event('c')], next: 'f/2' },
      { events: [], next: 'f/2' },
    ]);

    const batches = [];
    for await (const batch of logSources(client).logMessages('group', 'stream', window)) {
      batches.push(batch.map(({ message }) => message));
    }

    expect(batches).toEqual([['a', 'b'], ['c']]);
    expect(tokens).toEqual([undefined, 'f/1', 'f/2']);
  });

  it('reads a stream that fits one page, and one with no token', async () => {
    const { client } = logsClient([{ events: [event('only')], next: undefined }]);

    const messages = [];
    for await (const batch of logSources(client).logMessages('group', 'stream', window)) {
      messages.push(...batch.map(({ message }) => message));
    }

    expect(messages).toEqual(['only']);
  });

  it('lists the streams of every page', async () => {
    const client = new CloudWatchLogsClient(REGION);
    client.send = (async (command: unknown) => {
      if (!(command instanceof DescribeLogStreamsCommand)) throw new Error('unexpected command');
      return command.input.nextToken === undefined
        ? { logStreams: [{ logStreamName: 'one', firstEventTimestamp: 1 }], nextToken: 'p2' }
        : { logStreams: [{ logStreamName: 'two', firstEventTimestamp: 1 }] };
    }) as unknown as typeof client.send;

    expect(await logSources(client).logStreams('group', window)).toEqual(['one', 'two']);
  });
});

describe('CloudWatch metrics', () => {
  const target = metricTargetsOf(raise).find(({ label }) => label === 'database');
  const at = (minutes: number) => new Date(Date.parse(STARTED) + minutes * 60_000);

  function metricsClient(metricCount: number, pointsPerPage: number) {
    const client = new CloudWatchClient(REGION);
    const requests: { queries: number; token: string | undefined }[] = [];
    client.send = (async (command: unknown) => {
      if (command instanceof ListMetricsCommand) {
        return {
          Metrics: Array.from({ length: metricCount }, (_, index) => ({
            Namespace: 'AWS/RDS',
            MetricName: `Metric${index}`,
            Dimensions: [{ Name: 'DBInstanceIdentifier', Value: raise.database.identifier }],
          })),
        };
      }
      if (!(command instanceof GetMetricDataCommand)) throw new Error('unexpected command');
      const token = command.input.NextToken;
      requests.push({ queries: command.input.MetricDataQueries?.length ?? 0, token });
      const page = token === undefined ? 0 : Number(token);
      return {
        MetricDataResults: (command.input.MetricDataQueries ?? []).map((query) => ({
          Id: query.Id,
          Timestamps: Array.from({ length: pointsPerPage }, (_, i) => at(page * pointsPerPage + i)),
          Values: Array.from({ length: pointsPerPage }, (_, i) => page * pointsPerPage + i),
        })),
        NextToken: page < 2 ? String(page + 1) : undefined,
      };
    }) as unknown as typeof client.send;
    return { client, requests };
  }

  it('joins the points of a series that CloudWatch splits across pages, oldest first', async () => {
    if (target === undefined) throw new Error('the raise has no database target');
    const { client, requests } = metricsClient(1, 2);

    const series = await metricSources(client, metricTargetsOf(raise)).metricSeries(target, window);

    expect(requests.map(({ token }) => token)).toEqual([undefined, '1', '2']);
    expect(series[0]?.points.map(({ value }) => value)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(series[0]?.points.map(({ at: time }) => time)).toEqual(
      [0, 1, 2, 3, 4, 5].map((minutes) => at(minutes).toISOString()),
    );
  });

  it('asks for at most 500 queries at a time, and reads every metric of the target', async () => {
    if (target === undefined) throw new Error('the raise has no database target');
    const { client, requests } = metricsClient(101, 1);

    const series = await metricSources(client, metricTargetsOf(raise)).metricSeries(target, window);

    const firstPages = requests.filter(({ token }) => token === undefined);
    expect(firstPages.map(({ queries }) => queries)).toEqual([500, 5]);
    expect(new Set(series.map(({ name }) => name)).size).toBe(101);
    expect(series).toHaveLength(505);
  });
});

describe('ECS tasks', () => {
  const arn = (n: number) => `arn:aws:ecs:ap-southeast-2:1:task/load/task-${n}`;

  /** The page of task ARNs a ListTasks request asks for, with the token of the page after it. */
  function pageOf(command: ListTasksCommand, pages: readonly number[][]) {
    const page = command.input.nextToken === undefined ? 0 : Number(command.input.nextToken);
    return {
      taskArns: (pages[page] ?? []).map(arn),
      nextToken: page + 1 < pages.length ? String(page + 1) : undefined,
    };
  }

  function ecsClient(listed: Record<'STOPPED' | 'RUNNING', number[][]>) {
    const client = new ECSClient(REGION);
    const described: number[] = [];
    client.send = (async (command: unknown) => {
      if (command instanceof ListTasksCommand) {
        return pageOf(command, listed[command.input.desiredStatus as 'STOPPED' | 'RUNNING']);
      }
      if (!(command instanceof DescribeTasksCommand)) throw new Error('unexpected command');
      described.push(command.input.tasks?.length ?? 0);
      return { tasks: (command.input.tasks ?? []).map((taskArn) => ({ taskArn })), failures: [] };
    }) as unknown as typeof client.send;
    return { client, described };
  }

  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

  it('lists the tasks of every page, stopped and running, and describes them a hundred at a time', async () => {
    const { client, described } = ecsClient({
      STOPPED: [range(0, 100), range(100, 200)],
      RUNNING: [range(200, 250)],
    });

    const tasks = await ecsSources(client).tasks('load');

    expect(tasks).toHaveLength(250);
    expect(new Set(tasks.map(({ taskId }) => taskId)).size).toBe(250);
    expect(described).toEqual([100, 100, 50]);
  });

  it('finds no task in a cluster that has none, and asks ECS nothing more', async () => {
    const { client, described } = ecsClient({ STOPPED: [[]], RUNNING: [[]] });

    expect(await ecsSources(client).tasks('load')).toEqual([]);
    expect(described).toEqual([]);
  });
});

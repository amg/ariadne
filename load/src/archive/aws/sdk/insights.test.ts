import { type GetResourceMetricsCommandInput, PIClient } from '@aws-sdk/client-pi';
import { describe, expect, it, vi } from 'vitest';
import type { Insight } from '../../../records/index.ts';
import { busiestWaitsOf, insightSources, statementInWaitOf } from './insights.ts';

const window = {
  from: new Date('2026-10-15T00:00:00.000Z'),
  to: new Date('2026-10-15T01:00:00.000Z'),
};
const point = { Timestamp: new Date('2026-10-15T00:30:00.000Z'), Value: 0.5 };
const STATEMENT = {
  'db.sql_tokenized.id': 'Q1',
  'db.sql_tokenized.statement': 'insert into "billing"."daily_spend" values ($1)',
};

/** A Performance Insights client that answers each request from `answer`, and keeps what it was asked. */
function insightsAnswering(answer: (input: GetResourceMetricsCommandInput) => object) {
  const client = new PIClient({ region: 'ap-southeast-2' });
  const asked: GetResourceMetricsCommandInput[] = [];
  // Only the network call is replaced; `send` is overloaded, which a plain function cannot match.
  vi.spyOn(client, 'send').mockImplementation(async (command: { input: object }) => {
    const input = command.input as GetResourceMetricsCommandInput;
    asked.push(input);
    return answer(input) as never;
  });
  return { client, asked };
}

describe('the statements behind each wait', () => {
  it('names the wait beside the statement, and leaves out a total', () => {
    expect(
      statementInWaitOf(
        { Key: { Metric: 'db.load.avg', Dimensions: STATEMENT }, DataPoints: [point] },
        'Lock:object',
      ),
    ).toEqual([
      {
        group: 'query-in-wait',
        dimensions: { ...STATEMENT, 'db.wait_event.name': 'Lock:object' },
        at: '2026-10-15T00:30:00.000Z',
        averageActiveSessions: 0.5,
      },
    ]);
    expect(
      statementInWaitOf({ Key: { Metric: 'db.load.avg' }, DataPoints: [point] }, 'CPU'),
    ).toEqual([]);
  });

  it('asks for the busiest statements of each busiest wait, one wait at a time, and keeps them with the rest', async () => {
    const { client, asked } = insightsAnswering((input) => {
      const filter = input.MetricQueries?.[0]?.Filter;
      if (filter === undefined) {
        return {
          MetricList: [
            {
              Key: { Metric: 'db.load.avg', Dimensions: { 'db.wait_event.name': 'Lock:object' } },
              DataPoints: [{ ...point, Value: 0.9 }],
            },
            {
              Key: { Metric: 'db.load.avg', Dimensions: { 'db.wait_event.name': 'CPU' } },
              DataPoints: [point],
            },
          ],
        };
      }
      return {
        MetricList: [
          { Key: { Metric: 'db.load.avg', Dimensions: STATEMENT }, DataPoints: [point] },
        ],
      };
    });

    const insights = await insightSources(client).databaseInsights('db-ABC', window);

    expect(asked.slice(1).map((input) => input.MetricQueries?.[0]?.Filter)).toEqual([
      { 'db.wait_event.name': 'Lock:object' },
      { 'db.wait_event.name': 'CPU' },
    ]);
    expect(asked.slice(1).map((input) => input.MetricQueries?.[0]?.GroupBy?.Group)).toEqual([
      'db.sql_tokenized',
      'db.sql_tokenized',
    ]);
    expect(
      insights
        .filter((insight) => insight.group === 'query-in-wait')
        .map((insight) => insight.dimensions['db.wait_event.name']),
    ).toEqual(['Lock:object', 'CPU']);
    expect(insights.filter((insight) => insight.group === 'wait')).toHaveLength(2);
  });
});

describe('busiestWaitsOf', () => {
  const wait = (name: string, minute: number, sessions: number): Insight => ({
    group: 'wait',
    dimensions: { 'db.wait_event.name': name },
    at: new Date(Date.UTC(2026, 9, 15, 0, minute)).toISOString(),
    averageActiveSessions: sessions,
  });

  it('keeps the ten waits that held the most sessions over the window, busiest first', () => {
    const insights = Array.from({ length: 12 }, (_, index) => [
      wait(`wait-${index}`, 0, index),
      wait(`wait-${index}`, 1, index),
    ]).flat();

    expect(busiestWaitsOf(insights)).toEqual(
      Array.from({ length: 10 }, (_, index) => `wait-${11 - index}`),
    );
  });
});

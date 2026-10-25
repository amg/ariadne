import {
  GetResourceMetricsCommand,
  type MetricKeyDataPoints,
  type MetricQuery,
  type PIClient,
} from '@aws-sdk/client-pi';
import { INSIGHT_DIMENSIONS, type Insight } from '../../../records/index.ts';
import type { RaiseSources, TimeWindow } from '../sources.ts';

/** How many of the busiest waits, and of the busiest queries, are kept. */
const TOP = 10;

/** How many of the busiest statements are kept for each of the busiest waits. */
const STATEMENTS_PER_WAIT = 5;

const PERIOD_SECONDS = 60;

const GROUPS = [
  { group: 'wait', by: 'db.wait_event' },
  { group: 'query', by: 'db.sql_tokenized' },
] as const;

/** What Performance Insights groups the statements behind a wait by. */
const STATEMENTS = 'db.sql_tokenized';

/** The minutes of one wait or one query; a series with no dimensions is a total, which says nothing of which. */
export function insightsOf(series: MetricKeyDataPoints) {
  const dimensions = series.Key?.Dimensions ?? {};
  const names = Object.keys(dimensions);
  const group = GROUPS.find(({ by }) => names.some((name) => name.startsWith(`${by}.`)));
  if (group === undefined) return [];
  return pointsOf(series, group.group, dimensions);
}

/**
 * The minutes of one statement while the database waited on one wait: the
 * sessions that statement held in that wait. The wait is named among the
 * statement's dimensions. A series with no statement is a total, which
 * says nothing of which.
 */
export function statementInWaitOf(series: MetricKeyDataPoints, wait: string) {
  const dimensions = series.Key?.Dimensions ?? {};
  if (!Object.keys(dimensions).some((name) => name.startsWith(`${STATEMENTS}.`))) return [];
  return pointsOf(series, 'query-in-wait', {
    ...dimensions,
    [INSIGHT_DIMENSIONS.waitName]: wait,
  });
}

function pointsOf(
  series: MetricKeyDataPoints,
  group: Insight['group'],
  dimensions: Record<string, string>,
) {
  return (series.DataPoints ?? []).flatMap((point) =>
    point.Timestamp === undefined || point.Value === undefined
      ? []
      : [
          {
            group,
            dimensions,
            at: point.Timestamp.toISOString(),
            averageActiveSessions: point.Value,
          },
        ],
  );
}

/**
 * The busiest waits among the insights, by the sessions each held over the
 * whole window, busiest first. Each minute lists its own busiest, so the
 * minutes together can name more waits than are kept.
 */
export function busiestWaitsOf(insights: readonly Insight[]) {
  const sessions = new Map<string, number>();
  for (const insight of insights) {
    const wait = insight.dimensions[INSIGHT_DIMENSIONS.waitName];
    if (insight.group !== 'wait' || wait === undefined) continue;
    sessions.set(wait, (sessions.get(wait) ?? 0) + insight.averageActiveSessions);
  }
  return [...sessions]
    .sort(([a, held], [b, other]) => other - held || (a < b ? -1 : 1))
    .slice(0, TOP)
    .map(([wait]) => wait);
}

export function insightSources(client: PIClient): Pick<RaiseSources, 'databaseInsights'> {
  /** Every page of one request for the database's load, turned into insights by `read`. */
  async function readPages(
    resourceId: string,
    window: TimeWindow,
    queries: MetricQuery[],
    read: (series: MetricKeyDataPoints) => Insight[],
  ): Promise<Insight[]> {
    const insights: Insight[] = [];
    let token: string | undefined;
    do {
      // A permission or argument error says the call is wrong, not that the database is gone, so it stops the archive.
      const page = await client.send(
        new GetResourceMetricsCommand({
          ServiceType: 'RDS',
          Identifier: resourceId,
          StartTime: window.from,
          EndTime: window.to,
          PeriodInSeconds: PERIOD_SECONDS,
          MetricQueries: queries,
          NextToken: token,
        }),
      );
      insights.push(...(page.MetricList ?? []).flatMap(read));
      token = page.NextToken;
    } while (token !== undefined);
    return insights;
  }

  return {
    async databaseInsights(resourceId, window) {
      const busiest = await readPages(
        resourceId,
        window,
        GROUPS.map(({ by }) => ({ Metric: 'db.load.avg', GroupBy: { Group: by, Limit: TOP } })),
        insightsOf,
      );
      // A wait names what sessions waited on but not which statement made them wait, so each is asked for apart.
      const byWait: Insight[] = [];
      for (const wait of busiestWaitsOf(busiest)) {
        byWait.push(
          ...(await readPages(
            resourceId,
            window,
            [
              {
                Metric: 'db.load.avg',
                GroupBy: { Group: STATEMENTS, Limit: STATEMENTS_PER_WAIT },
                Filter: { [INSIGHT_DIMENSIONS.waitName]: wait },
              },
            ],
            (series) => statementInWaitOf(series, wait),
          )),
        );
      }
      return [...busiest, ...byWait];
    },
  };
}

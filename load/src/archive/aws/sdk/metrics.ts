import {
  type CloudWatchClient,
  type Dimension,
  GetMetricDataCommand,
  type Metric,
  type MetricDataQuery,
  paginateListMetrics,
} from '@aws-sdk/client-cloudwatch';
import type { MetricSeries } from '../../../records/index.ts';
import type { MetricTarget } from '../raise.ts';
import type { RaiseSources } from '../sources.ts';

/** The finest period CloudWatch holds for what aws-prod publishes: nothing it runs is published more often than every minute. */
const FINEST_PERIOD_SECONDS = 60;

const STATISTICS = ['Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount'] as const;

/** The most queries one request to CloudWatch takes. */
const QUERIES_PER_REQUEST = 500;

type Described = { namespace: string; name: string; dimensions: Record<string, string> };

/** How many of a target's dimensions a metric satisfies; null when it fails any. */
function specificity(metric: Described, target: MetricTarget) {
  const wanted = Object.entries(target.dimensions);
  const satisfied = wanted.every(([name, value]) =>
    name === '*'
      ? Object.values(metric.dimensions).includes(value)
      : metric.dimensions[name] === value,
  );
  return satisfied && target.namespaces.includes(metric.namespace) ? wanted.length : null;
}

/** The target that owns a metric: the one that names the most of its dimensions, the first of them when several tie. */
function ownerOrNull(metric: Described, targets: readonly MetricTarget[]) {
  let owner: MetricTarget | null = null;
  let best = -1;
  for (const target of targets) {
    const score = specificity(metric, target);
    if (score !== null && score > best) {
      owner = target;
      best = score;
    }
  }
  return owner;
}

/**
 * The metrics that belong to `target`, out of all that were found, so that a
 * service's metrics are not also its cluster's. A target is known by its
 * label, so a target described again from the same raise finds the same metrics.
 */
export function metricsOfTarget(
  target: MetricTarget,
  allTargets: readonly MetricTarget[],
  metrics: readonly Described[],
) {
  return metrics.filter((metric) => ownerOrNull(metric, allTargets)?.label === target.label);
}

const dimensionsOf = (dimensions: readonly Dimension[] | undefined) =>
  Object.fromEntries(
    (dimensions ?? []).flatMap((dimension) =>
      dimension.Name === undefined || dimension.Value === undefined
        ? []
        : [[dimension.Name, dimension.Value]],
    ),
  );

function describedMetricOrNull(metric: Metric) {
  if (metric.Namespace === undefined || metric.MetricName === undefined) return null;
  return {
    namespace: metric.Namespace,
    name: metric.MetricName,
    dimensions: dimensionsOf(metric.Dimensions),
  };
}

export function metricSources(
  client: CloudWatchClient,
  allTargets: readonly MetricTarget[],
): Pick<RaiseSources, 'metricSeries'> {
  const listed = new Map<string, Promise<Described[]>>();
  const listNamespace = (namespace: string): Promise<Described[]> => {
    const known = listed.get(namespace);
    if (known !== undefined) return known;
    const fresh = (async () => {
      const found: Described[] = [];
      for await (const page of paginateListMetrics({ client }, { Namespace: namespace })) {
        for (const metric of page.Metrics ?? []) {
          const described = describedMetricOrNull(metric);
          if (described !== null) found.push(described);
        }
      }
      return found;
    })();
    listed.set(namespace, fresh);
    return fresh;
  };

  return {
    async metricSeries(target, window) {
      const everything = (await Promise.all(target.namespaces.map(listNamespace))).flat();
      const mine = metricsOfTarget(target, allTargets, everything);
      const queries = mine.flatMap((metric, index) =>
        STATISTICS.map((statistic) => ({
          metric,
          statistic,
          id: `m${index}${statistic.toLowerCase()}`,
        })),
      );
      const series: MetricSeries[] = [];
      for (let first = 0; first < queries.length; first += QUERIES_PER_REQUEST) {
        const batch = queries.slice(first, first + QUERIES_PER_REQUEST);
        const points = await pointsOf(client, batch, window);
        for (const { metric, statistic, id } of batch) {
          const found = points.get(id) ?? [];
          if (found.length === 0) continue;
          series.push({
            namespace: metric.namespace,
            name: metric.name,
            dimensions: metric.dimensions,
            statistic,
            periodSeconds: FINEST_PERIOD_SECONDS,
            points: found,
          });
        }
      }
      return series;
    },
  };
}

async function pointsOf(
  client: CloudWatchClient,
  batch: readonly { metric: Described; statistic: string; id: string }[],
  window: { from: Date; to: Date },
) {
  const queries: MetricDataQuery[] = batch.map(({ metric, statistic, id }) => ({
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: metric.namespace,
        MetricName: metric.name,
        Dimensions: Object.entries(metric.dimensions).map(([Name, Value]) => ({ Name, Value })),
      },
      Period: FINEST_PERIOD_SECONDS,
      Stat: statistic,
    },
    ReturnData: true,
  }));
  const points = new Map<string, { at: string; value: number }[]>();
  let token: string | undefined;
  do {
    const page = await client.send(
      new GetMetricDataCommand({
        MetricDataQueries: queries,
        StartTime: window.from,
        EndTime: window.to,
        ScanBy: 'TimestampAscending',
        NextToken: token,
      }),
    );
    for (const result of page.MetricDataResults ?? []) {
      const known = points.get(result.Id ?? '') ?? [];
      const timestamps = result.Timestamps ?? [];
      const values = result.Values ?? [];
      points.set(result.Id ?? '', [
        ...known,
        ...timestamps.flatMap((at, index) => {
          const value = values[index];
          return value === undefined ? [] : [{ at: at.toISOString(), value }];
        }),
      ]);
    }
    token = page.NextToken;
  } while (token !== undefined);
  return points;
}

import { allSignals } from './catalogue.ts';

/** The metric a CloudWatch search asks for. */
export type SearchedMetric = {
  namespace: string;
  /** The dimensions of the search's schema, in order. */
  dimensions: string[];
  name: string;
  statistic: string;
};

/** Every metric that the CloudWatch searches written in a text ask for. Quotes may be escaped, as in a dashboard's body. */
export function searchedMetricsIn(text: string) {
  const plain = text.replaceAll('\\', '');
  return [...plain.matchAll(/SEARCH\('\{([^}]+)\} MetricName="([^"]+)"[^']*', '(\w+)'/g)].map(
    ([, schema = '', name = '', statistic = '']) => {
      const [namespace = '', ...dimensions] = schema.split(',');
      return { namespace, dimensions, name, statistic };
    },
  );
}

/** Whether the catalogue holds a signal that reads this metric, with these dimensions, at this statistic. */
export function isInCatalogue(metric: SearchedMetric) {
  return allSignals().some(
    (signal) =>
      signal.namespace === metric.namespace &&
      signal.name === metric.name &&
      signal.statistic === metric.statistic &&
      signal.dimensions.join(',') === metric.dimensions.join(','),
  );
}

/** A metric a log line publishes. */
export type PublishedMetric = {
  namespace: string;
  dimensions: string[];
  name: string;
  unit: string;
};

type MetricsBlock = {
  _aws?: {
    CloudWatchMetrics?: {
      Namespace: string;
      Dimensions: string[][];
      Metrics: { Name: string; Unit: string }[];
    }[];
  };
};

/** Every metric the fields of a log line publish. */
export function publishedMetricsIn(fields: object) {
  // The fields are whatever a log line holds; only the block that names its metrics is read.
  const block = fields as MetricsBlock;
  return (block._aws?.CloudWatchMetrics ?? []).flatMap((set) =>
    set.Metrics.map(({ Name, Unit }) => ({
      namespace: set.Namespace,
      dimensions: set.Dimensions[0] ?? [],
      name: Name,
      unit: Unit,
    })),
  );
}

/** Whether the catalogue holds a signal of this published metric, with its dimensions and unit. */
export function isPublishedInCatalogue(metric: PublishedMetric) {
  return allSignals().some(
    (signal) =>
      signal.namespace === metric.namespace &&
      signal.name === metric.name &&
      signal.unit === metric.unit &&
      signal.dimensions.join(',') === metric.dimensions.join(','),
  );
}

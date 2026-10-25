import type { MetricUnit, Signal } from './catalogue.ts';

/** One figure of a log line: its name, its value and its unit. */
export type Measure = { name: string; value: number; unit: MetricUnit };

/** A figure of a signal, carrying the value a log line has for it. */
export function measureOf(signal: Pick<Signal, 'name' | 'unit'>, value: number) {
  return { name: signal.name, value, unit: signal.unit };
}

/**
 * Figures that are published together under the same dimensions. Each
 * dimension is a name and the value this line carries for it. A group with
 * no dimensions publishes figures that add up over everything that writes
 * them.
 */
export type MetricGroup = {
  dimensions?: Readonly<Record<string, string>>;
  measures: readonly Measure[];
};

/**
 * The fields that make a JSON log line also publish its figures as
 * CloudWatch metrics. Spread them into the line next to its record. A
 * name used as a dimension must not also be used as a figure or by another
 * group with a different value.
 *
 * Returns nothing to add when no group has a figure, because a line that
 * names metrics it does not carry is reported as malformed.
 */
export function metricFields(namespace: string, at: Date, groups: readonly MetricGroup[]) {
  const published = groups.filter((group) => group.measures.length > 0);
  if (published.length === 0) return {};
  const fields: Record<string, unknown> = {};
  for (const group of published) {
    Object.assign(fields, group.dimensions);
    for (const { name, value } of group.measures) fields[name] = value;
  }
  return {
    _aws: {
      Timestamp: at.getTime(),
      CloudWatchMetrics: published.map((group) => ({
        Namespace: namespace,
        Dimensions: [Object.keys(group.dimensions ?? {})],
        Metrics: group.measures.map(({ name, unit }) => ({ Name: name, Unit: unit })),
      })),
    },
    ...fields,
  };
}

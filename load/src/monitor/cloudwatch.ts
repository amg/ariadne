import {
  type CloudWatchClient,
  type MetricDataResult,
  paginateGetMetricData,
} from '@aws-sdk/client-cloudwatch';
import { type MonitorScope, monitorQueries } from './queries.ts';
import type { Series } from './series.ts';

/** Reads what `monitor` shows from CloudWatch, for the time between `from` and `to`, narrowed to the stack in `scope`. */
export async function fetchSeries(
  client: CloudWatchClient,
  window: { from: Date; to: Date },
  scope: MonitorScope,
) {
  const found: Series[] = [];
  const pages = paginateGetMetricData(
    { client },
    {
      MetricDataQueries: monitorQueries(scope),
      StartTime: window.from,
      EndTime: window.to,
      ScanBy: 'TimestampAscending',
    },
  );
  for await (const page of pages) {
    found.push(...(page.MetricDataResults ?? []).map(seriesOf));
  }
  return found;
}

/**
 * One series from one result. A series that arrives over several pages
 * becomes several, whose points never overlap, so combining the series of a
 * label at each minute gives the same figures as joining them first.
 */
function seriesOf(result: MetricDataResult): Series {
  const values = result.Values ?? [];
  return {
    label: result.Label ?? '',
    points: (result.Timestamps ?? []).flatMap((at, index) => {
      const value = values[index];
      return value === undefined ? [] : [{ at, value }];
    }),
  };
}

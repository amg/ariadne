import type { AwsEvent, Insight, MetricSeries } from '../../records/index.ts';
import type { TaskInfo } from '../../types/archive.ts';
import type { MetricTarget } from './raise.ts';

/** A stretch of time to collect, from and to, both included. */
export type TimeWindow = { from: Date; to: Date };

/** One message of a log stream, and when CloudWatch says it was logged, in UTC. */
export type LogEvent = { at: string; message: string };

/** What is asked of a thing that is no longer there, such as a deleted stack's cluster. */
export class SourceUnavailable extends Error {}

/**
 * Everything a raise holds that an archive copies, each behind one call.
 * Every call that reads a thing the raise may no longer hold rejects with
 * `SourceUnavailable` when it is gone.
 */
export type RaiseSources = {
  logStreams: (group: string, window: TimeWindow) => Promise<string[]>;
  /** The messages of one stream inside the window, in the order they were logged, a batch at a time. */
  logMessages: (
    group: string,
    stream: string,
    window: TimeWindow,
  ) => AsyncIterable<readonly LogEvent[]>;
  metricSeries: (target: MetricTarget, window: TimeWindow) => Promise<MetricSeries[]>;
  tasks: (cluster: string) => Promise<TaskInfo[]>;
  /** What the services say of themselves: their events and their deployments. */
  serviceEvents: (cluster: string, services: readonly string[]) => Promise<AwsEvent[]>;
  scalingActivity: (cluster: string, services: readonly string[]) => Promise<AwsEvent[]>;
  /** The database's busiest waits and queries, minute by minute. */
  databaseInsights: (resourceId: string, window: TimeWindow) => Promise<Insight[]>;
};

import { z } from 'zod';
import { instant } from './instant.ts';
import { recordKind } from './versioned.ts';

/**
 * One statistic of one CloudWatch metric over the run, as CloudWatch
 * delivered it: its points in time order, and the period they are at.
 */
const metricSeriesSchema = z.object({
  namespace: z.string(),
  name: z.string(),
  dimensions: z.record(z.string(), z.string()),
  statistic: z.string(),
  periodSeconds: z.number().int(),
  points: z.array(z.object({ at: instant, value: z.number() })),
});
export type MetricSeries = z.infer<typeof metricSeriesSchema>;
export const metricSeriesRecords = recordKind('metric-series', metricSeriesSchema);

/** Where an infrastructure event was recorded. */
const AWS_EVENT_SOURCES = ['ecs-service', 'task-stop', 'scaling', 'deployment'] as const;

/**
 * Something AWS recorded about the raise: a service's own event, why a
 * task stopped, a scaling decision or a deployment.
 * `detail` keeps what the source said beyond the summary.
 */
const awsEventSchema = z.object({
  at: instant,
  source: z.enum(AWS_EVENT_SOURCES),
  resource: z.string(),
  summary: z.string(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type AwsEvent = z.infer<typeof awsEventSchema>;
export const awsEventRecords = recordKind('aws-event', awsEventSchema);

/**
 * How much of the database's load one wait or one query carried in one
 * minute, as Performance Insights delivered it: average active sessions.
 * `dimensions` names the wait event or the query. A query in a wait is
 * one statement's sessions in one wait, and its dimensions name both.
 */
const insightSchema = z.object({
  group: z.enum(['wait', 'query', 'query-in-wait']),
  dimensions: z.record(z.string(), z.string()),
  at: instant,
  averageActiveSessions: z.number(),
});
export type Insight = z.infer<typeof insightSchema>;

/** The dimensions that name a wait or a query in what Performance Insights delivers. */
export const INSIGHT_DIMENSIONS = {
  waitName: 'db.wait_event.name',
  waitType: 'db.wait_event.type',
  queryId: 'db.sql_tokenized.id',
  queryStatement: 'db.sql_tokenized.statement',
} as const;
export const insightRecords = recordKind('performance-insight', insightSchema);

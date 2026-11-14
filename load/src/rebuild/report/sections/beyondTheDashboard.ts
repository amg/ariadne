import { AWS_METRIC_RESOURCES, LAYOUT } from '../../../records/index.ts';
import type { InsightsSummary, Marker } from '../../types.ts';
import { EDGE_SERVER_ERRORS } from '../../table/index.ts';
import { type Builder, type Section, inAwsMetrics, inFile } from '../builder.ts';

/** As many waits as the chart can tell apart by colour. */
const WAITS_CHARTED = 6;
const STATEMENT_LENGTH = 160;

/** What the report says of a run that did not keep the statements behind each wait. */
export const STATEMENTS_NOT_KEPT =
  'The run did not keep the statements behind each wait, so the waits above cannot be traced to a statement.';

export function hostSection({ line, chart, passLine }: Builder): Section {
  const host = inFile(LAYOUT.hostSamples);
  return {
    heading: 'The host',
    charts: [
      chart(
        'Host CPU',
        '%',
        [line('busiest minute', 'host_cpu_percent_max', host)],
        passLine('host-cpu', 'host CPU'),
      ),
      chart(
        'Memory in use',
        '%',
        [line('highest in the minute', 'memory_used_percent_max', host)],
        passLine('memory', 'memory'),
      ),
    ],
    tables: [],
  };
}

/** A query's text on one line, cut short enough to read in a table. */
function shortStatement(statement: string) {
  const oneLine = statement.replace(/\s+/g, ' ').trim();
  return oneLine.length <= STATEMENT_LENGTH ? oneLine : `${oneLine.slice(0, STATEMENT_LENGTH)}…`;
}

export function insightsSection({ split, chart }: Builder, insights: InsightsSummary): Section {
  const charted = new Set(insights.waits.slice(0, WAITS_CHARTED).map(({ wait }) => wait));
  return {
    heading: 'Where the database spent its time (Performance Insights)',
    charts: [
      chart(
        'Sessions, by what they waited on',
        'average active sessions',
        split('db_wait', (column) => charted.has(column.of?.value ?? '')),
      ),
    ],
    tables: [
      {
        caption: 'Busiest waits',
        header: ['Wait', 'Type', 'Sessions on average', 'Most sessions'],
        rows: insights.waits.map((wait) => [
          wait.wait,
          wait.type,
          wait.meanSessions,
          wait.peakSessions,
        ]),
        empty: 'No wait was measured during the run.',
      },
      {
        caption: 'Busiest queries',
        header: ['Query', 'Sessions on average', 'Most sessions'],
        rows: insights.queries.map((query) => [
          shortStatement(query.statement),
          query.meanSessions,
          query.peakSessions,
        ]),
        empty: 'No query was measured during the run.',
      },
      {
        caption: 'Busiest statements behind each wait',
        header: ['Wait', 'Statement', 'Sessions on average', 'Most sessions'],
        rows: (insights.statementsByWait ?? []).flatMap(({ wait, statements }) =>
          statements.map((statement) => [
            wait,
            shortStatement(statement.statement),
            statement.meanSessions,
            statement.peakSessions,
          ]),
        ),
        empty:
          insights.statementsByWait === null
            ? STATEMENTS_NOT_KEPT
            : 'No statement was measured behind any wait during the run.',
      },
    ],
  };
}

/**
 * CloudFront's distribution, in front of the load balancer: what it served,
 * the errors it answered with, which of its server errors it gave itself,
 * and how long the load balancer took to start answering it.
 */
export function edgeSection({ line, chart }: Builder): Section {
  const edge = inAwsMetrics(AWS_METRIC_RESOURCES.distribution);
  return {
    heading: 'Traffic at the edge',
    charts: [
      chart('Requests', 'per minute', [line('requests', 'edge_requests', edge)]),
      chart('Server errors', 'per minute', [
        line('all', EDGE_SERVER_ERRORS.all, edge),
        line('given by the edge itself', EDGE_SERVER_ERRORS.givenByEdge, edge),
      ]),
      chart('Errors, as a share of requests', '%', [
        line('4xx', 'edge_4xx_percent', edge),
        line('5xx', 'edge_5xx_percent', edge),
        line('502', 'edge_502_percent', edge),
        line('503', 'edge_503_percent', edge),
        line('504', 'edge_504_percent', edge),
      ]),
      chart('How long the load balancer took to start answering', 'ms', [
        line('average', 'edge_origin_latency_average_ms', edge),
        line('slowest', 'edge_origin_latency_slowest_ms', edge),
      ]),
      chart('Sent to users', 'MiB per minute', [line('sent', 'edge_sent_mib', edge)]),
    ],
    tables: [],
  };
}

export function targetGroupsSection({ split, chart }: Builder): Section {
  return {
    heading: 'Target groups',
    charts: [
      chart('Requests, by target group', 'per minute', split('target_group_requests')),
      chart('Healthy targets', 'fewest in the minute', split('target_group_healthy')),
      chart('Unhealthy targets', 'most in the minute', split('target_group_unhealthy')),
    ],
    tables: [],
  };
}

/** The moments the charts mark, by the number each chart writes above its line. */
export function markersSection(markers: readonly Marker[]): Section {
  return {
    heading: 'Moments marked on the charts',
    charts: [],
    tables: [
      {
        caption: 'Generator launches and stops, scaling and deployments',
        header: ['#', 'At', 'What happened'],
        rows: markers.map((marker, index) => [index + 1, marker.at, marker.what]),
        empty: 'Nothing was marked.',
      },
    ],
  };
}

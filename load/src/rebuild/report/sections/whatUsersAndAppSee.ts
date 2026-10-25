import { SHARES, SIGNALS } from '@ari/lib/metrics/catalogue';
import { AWS_METRIC_RESOURCES, LAYOUT, REQUEST_KINDS } from '../../../records/index.ts';
import { BUSIEST_GENERATOR_CPU, failureColumnName } from '../../table/index.ts';
import type { FailureCount } from '../../types.ts';
import {
  type Builder,
  GENERATOR_REQUESTS,
  GENERATOR_STATE,
  type Section,
  type Table,
  inAwsMetrics,
  inFile,
} from '../builder.ts';

/** Every way a request failed, with how many times it did. */
function failuresTable(failures: readonly FailureCount[]): Table {
  return {
    caption: 'Failures, counted',
    header: ['Kind', 'Status', 'Error code', 'Failed'],
    rows: failures.map((failure) => [
      failure.kind,
      failure.status ?? 'no response',
      failure.errorCode ?? 'no code',
      failure.count,
    ]),
    empty: 'No request failed.',
  };
}

export function usersSection(
  { line, chart, passLine }: Builder,
  failures: readonly FailureCount[],
): Section {
  const failureLines = REQUEST_KINDS.map((kind) =>
    line(kind, failureColumnName(kind), GENERATOR_REQUESTS),
  ).filter((failing) => failing.values.some((value) => value !== null && value > 0));
  return {
    heading: 'What users see',
    charts: [
      chart(
        'Users online',
        'users',
        [
          line('signed in', 'users_signed_in', GENERATOR_STATE),
          line('push streams open', 'push_streams_open', GENERATOR_STATE),
        ],
        passLine('push-streams', 'push streams'),
      ),
      chart(
        'Chatters active',
        'users',
        [line('chatters active', 'chatters_active', GENERATOR_STATE)],
        passLine('chatters', 'chatters'),
      ),
      chart(
        'Chat first byte',
        'ms',
        [
          line('p50', 'chat_first_byte_p50_ms', GENERATOR_REQUESTS),
          line('p95', 'chat_first_byte_p95_ms', GENERATOR_REQUESTS),
          line('p99', 'chat_first_byte_p99_ms', GENERATOR_REQUESTS),
        ],
        passLine('first-byte-p95', 'p95', SIGNALS.load.chatFirstByteP95),
      ),
      chart(
        'Failures by kind',
        'requests per minute',
        failureLines.length > 0 ? failureLines : [line('none', 'failures', GENERATOR_REQUESTS)],
      ),
      chart(
        'Requests that failed',
        '% of requests',
        [line('failed', 'failed_percent', GENERATOR_REQUESTS)],
        passLine('errors', 'failed'),
      ),
    ],
    tables: [failuresTable(failures)],
  };
}

export function generatorsSection({ line, chart, passLine }: Builder): Section {
  const cluster = inAwsMetrics(AWS_METRIC_RESOURCES.generatorCluster);
  return {
    heading: 'The generators against their limits',
    charts: [
      chart(
        'Sign-in failures',
        '% of sign-ins',
        [line('sign-ins that failed', 'signin_failures_percent', GENERATOR_REQUESTS)],
        passLine('sign-in-failures', 'failed', SHARES.signInFailures),
      ),
      chart(
        'Generator CPU',
        '% of reserved',
        [
          line('all generators together', 'generators_cpu_percent', cluster),
          line('busiest generator', BUSIEST_GENERATOR_CPU, cluster),
        ],
        passLine('generator-cpu', 'busiest generator', SHARES.generatorCpuBusiest),
      ),
      chart('Generator memory, all generators together', '% of reserved', [
        line('memory', 'generators_memory_percent', cluster),
      ]),
    ],
    tables: [],
  };
}

export function appSection({ line, split, chart }: Builder): Section {
  const exchanges = inFile(LAYOUT.exchanges);
  const jobs = inFile(LAYOUT.jobs);
  const appState = inFile(LAYOUT.appState);
  const apiRequests = inFile(LAYOUT.appRequests);
  return {
    heading: 'What the app sees',
    charts: [
      chart('Push streams per API task', 'streams', [
        line('average task', 'app_push_streams_average', appState),
        line('busiest task', 'app_push_streams_open', appState),
      ]),
      chart('Time jobs wait in the queue', 'ms', [
        line('p50 of jobs started', 'app_job_wait_p50_ms', jobs),
        line('p95 of jobs started', 'app_job_wait_p95_ms', jobs),
        line('oldest job waiting', 'app_oldest_job_wait_max_ms', appState),
      ]),
      chart('Jobs run, by queue task', 'per minute', split('jobs_run')),
      chart('Requests the API answered', 'per minute', [
        line('requests', 'app_requests', apiRequests),
        line('answered with a server error', 'app_requests_5xx', apiRequests),
      ]),
      chart('Server time per request', 'ms', [line('p95', 'app_server_time_p95_ms', apiRequests)]),
      chart('Chat exchanges', 'per minute', [line('exchanges', 'app_exchanges', exchanges)]),
      chart('First token, as the API saw it', 'ms', [
        line('p95', 'app_first_token_p95_ms', exchanges),
      ]),
    ],
    tables: [],
  };
}

/** What gives out first in a copy of the backend: the figures that say which part is full. */
export function copiesSection({ line, split, chart }: Builder): Section {
  const appState = inFile(LAYOUT.appState);
  // A chart of one copy alone would only repeat the busiest copy's.
  const eachCopy = (title: string, unit: string, figure: string) => {
    const lines = split(figure);
    return lines.length > 1 ? [chart(title, unit, lines)] : [];
  };
  return {
    heading: 'How loaded each copy is',
    charts: [
      chart('Event loop delay, busiest copy', 'ms', [
        line('p99 of the minute', 'app_event_loop_delay_p99_max_ms', appState),
      ]),
      chart('Memory, busiest copy', 'MiB', [
        line('resident', 'app_resident_max_mib', appState),
        line('heap in use', 'app_heap_used_max_mib', appState),
      ]),
      chart('Database connections, busiest copy', 'connections', [
        line('in use', 'app_db_connections_in_use_max', appState),
        line('requests waiting', 'app_db_connections_waiting_max', appState),
      ]),
      chart('Jobs running at once, busiest worker', 'jobs', [
        line('busy slots', 'app_worker_slots_busy_max', appState),
        line('slots it has', 'app_worker_slots', appState),
      ]),
      chart('Sends between copies that failed', 'per minute', [
        line('failed', 'app_push_bus_failures', appState),
      ]),
      ...eachCopy('Event loop delay, each copy', 'ms', 'copy_event_loop_delay_p99_ms'),
      ...eachCopy(
        'Database connections waited for, each copy',
        'requests waiting',
        'copy_db_connections_waiting',
      ),
      ...eachCopy('Push streams open, each API copy', 'streams', 'copy_push_streams_open'),
      ...eachCopy('Jobs running at once, each worker', 'jobs', 'copy_worker_slots_busy'),
    ],
    tables: [],
  };
}

export function gateSection({ line, split, chart, passLine }: Builder): Section {
  return {
    heading: 'The Drift gate',
    charts: [
      chart('Verdicts, by outcome', 'per minute', split('gate_verdicts')),
      chart(
        'Gate waits that hit the limit',
        '% of verdicts',
        [line('waits at the limit', 'gate_waits_at_limit_percent', inFile(LAYOUT.exchanges))],
        passLine('gate-waits-at-limit', 'waits', SHARES.gateWaitsAtLimit),
      ),
    ],
    tables: [],
  };
}

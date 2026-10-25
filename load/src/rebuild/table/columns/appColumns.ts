import { type AppStateLine, LAYOUT, judgedVerdictOrNull } from '../../../records/index.ts';
import { meanOf, percentOrNull, percentileOf, roundTo } from '../../numbers.ts';
import { compareText } from '../../numbers.ts';
import { copyLabelsOf, gateWaitCounts, jobWaitMs } from '../../runData/index.ts';
import type { Cell, RunData } from '../../types.ts';
import { type Column, byMinute, countsByValue, maxInMinute, splitName } from './minutes.ts';

/** A figure of a source the run holds; null in every minute for a source it does not. */
const known =
  (present: boolean, figure: (minute: number) => Cell): ((minute: number) => Cell) =>
  (minute) =>
    present ? figure(minute) : null;

const BYTES_PER_MIB = 1_048_576;

/** A figure in bytes as mebibytes, to a tenth; null where it was not measured. */
const mebibytesOrNull = (bytes: number | null) =>
  bytes === null ? null : roundTo(bytes / BYTES_PER_MIB, 1);

/** The sum of a figure over a minute's state lines; null where none of them measured it. */
function sumInMinuteOrNull(
  data: RunData,
  pick: (state: AppStateLine) => number | null,
): (minute: number) => Cell {
  const minutes = byMinute(data.appStates ?? [], (state) => state.at);
  return (minute) => {
    const measured = (minutes.get(minute) ?? []).flatMap((state) => pick(state) ?? []);
    return measured.length === 0 ? null : measured.reduce((sum, figure) => sum + figure, 0);
  };
}

/**
 * What each copy says of how loaded it is, from its state lines. A figure
 * is the highest any copy gave in the minute, so the busiest copy shows.
 */
export function copyLoadColumns(data: RunData): Column[] {
  const busiest = (name: string, pick: (state: AppStateLine) => number | null): Column => ({
    name,
    at: maxInMinute(data.appStates, pick),
  });
  return [
    busiest('app_event_loop_delay_p99_max_ms', (state) => state.eventLoopDelayP99Ms),
    busiest('app_heap_used_max_mib', (state) => mebibytesOrNull(state.heapUsedBytes)),
    busiest('app_resident_max_mib', (state) => mebibytesOrNull(state.residentBytes)),
    busiest('app_db_connections_in_use_max', (state) => state.dbConnectionsInUse),
    busiest('app_db_connections_waiting_max', (state) => state.dbConnectionsWaiting),
    busiest('app_worker_slots_busy_max', (state) => state.workerSlotsBusy),
    busiest('app_worker_slots', (state) => state.workerSlots),
    {
      name: 'app_push_bus_failures',
      at: sumInMinuteOrNull(data, (state) => state.pushBusFailures),
    },
  ];
}

/** The figures of a copy's state lines that are shown copy by copy, each by the column it is split into. */
const COPY_FIGURES: readonly { figure: string; pick: (state: AppStateLine) => number | null }[] = [
  { figure: 'copy_event_loop_delay_p99_ms', pick: (state) => state.eventLoopDelayP99Ms },
  { figure: 'copy_db_connections_waiting', pick: (state) => state.dbConnectionsWaiting },
  { figure: 'copy_db_connections_in_use', pick: (state) => state.dbConnectionsInUse },
  { figure: 'copy_push_streams_open', pick: (state) => state.pushStreamsOpen },
  { figure: 'copy_worker_slots_busy', pick: (state) => state.workerSlotsBusy },
  { figure: 'copy_oldest_job_wait_ms', pick: (state) => state.oldestJobWaitMs },
  { figure: 'copy_resident_mib', pick: (state) => mebibytesOrNull(state.residentBytes) },
];

/**
 * What each copy said of itself, copy by copy: the highest it gave in the
 * minute, split by the copy's label, such as `api-8536ff1a`.
 */
export function eachCopyColumns(data: RunData): Column[] {
  const states = data.appStates ?? [];
  const labels = copyLabelsOf(states);
  return COPY_FIGURES.flatMap(({ figure, pick }) =>
    [...labels].map(([copy, label]) => ({
      name: splitName(figure, label),
      of: { figure, value: label, source: LAYOUT.appState },
      at: maxInMinute(
        states.filter((state) => state.copy === copy),
        pick,
      ),
    })),
  );
}

/** How many jobs of each task started in each minute, and how long they ran on average. */
export function jobsByTaskColumns(data: RunData): Column[] {
  if (data.jobs === null) return [];
  const tasks = [...new Set(data.jobs.map((job) => job.task))].sort(compareText);
  const started = byMinute(data.jobs, (job) => job.startedAt);
  const ofTask = (minute: number, task: string) =>
    (started.get(minute) ?? []).filter((job) => job.task === task);
  return [
    ...tasks.map((task) => ({
      name: splitName('jobs_started', task),
      of: { figure: 'jobs_started', value: task, source: LAYOUT.jobs },
      at: (minute: number) => ofTask(minute, task).length,
    })),
    ...tasks.map((task) => ({
      name: splitName('job_run_mean_ms', task),
      of: { figure: 'job_run_mean_ms', value: task, source: LAYOUT.jobs },
      at: (minute: number) => meanOf(ofTask(minute, task).map((job) => job.durationMs)),
    })),
  ];
}

/** What the API answered, from its request lines, by the minute each response ended. */
export function apiRequestColumns(data: RunData): Column[] {
  const requests = byMinute(data.appRequests ?? [], (line) => line.endedAt);
  const inMinute = (minute: number) => requests.get(minute) ?? [];
  return [
    {
      name: 'app_requests',
      at: known(data.appRequests !== null, (minute) => inMinute(minute).length),
    },
    {
      name: 'app_requests_5xx',
      at: known(
        data.appRequests !== null,
        (minute) => inMinute(minute).filter((line) => line.statusCode >= 500).length,
      ),
    },
    {
      name: 'app_server_time_p95_ms',
      at: (minute) =>
        percentileOf(
          inMinute(minute).map((line) => line.durationMs),
          0.95,
        ),
    },
  ];
}

/** What the app carried, from its exchange, job and state lines. */
export function appColumns(data: RunData): Column[] {
  const exchanges = byMinute(data.exchanges ?? [], (line) => line.arrivedAt);
  const jobs = byMinute(data.jobs ?? [], (job) => job.startedAt);
  const states = byMinute(data.appStates ?? [], (state) => state.at);
  const jobWaits = (minute: number) => (jobs.get(minute) ?? []).map(jobWaitMs);
  return [
    {
      name: 'app_exchanges',
      at: known(data.exchanges !== null, (minute) => exchanges.get(minute)?.length ?? 0),
    },
    {
      name: 'app_first_token_p95_ms',
      at: (minute) =>
        percentileOf(
          (exchanges.get(minute) ?? []).flatMap((line) => line.firstTokenAfterMs ?? []),
          0.95,
        ),
    },
    {
      name: 'app_jobs_started',
      at: known(data.jobs !== null, (minute) => jobs.get(minute)?.length ?? 0),
    },
    { name: 'app_job_wait_p50_ms', at: (minute) => percentileOf(jobWaits(minute), 0.5) },
    { name: 'app_job_wait_p95_ms', at: (minute) => percentileOf(jobWaits(minute), 0.95) },
    {
      name: 'app_oldest_job_wait_max_ms',
      at: maxInMinute(data.appStates, (state) => state.oldestJobWaitMs),
    },
    {
      name: 'app_push_streams_average',
      at: (minute) =>
        meanOf((states.get(minute) ?? []).flatMap((state) => state.pushStreamsOpen ?? [])),
    },
    {
      name: 'app_push_streams_open',
      at: maxInMinute(data.appStates, (state) => state.pushStreamsOpen),
    },
    ...countsByValue({
      figure: 'jobs_run',
      items: data.jobs,
      value: (job) => job.task,
      atOf: (job) => job.finishedAt,
      source: LAYOUT.jobs,
    }),
  ];
}

/**
 * What the Drift gate decided, from the exchange lines. A verdict a retry
 * replayed was judged, and counted, once already.
 */
export function gateColumns(data: RunData): Column[] {
  const exchanges = byMinute(data.exchanges ?? [], (line) => line.arrivedAt);
  return [
    ...countsByValue({
      figure: 'gate_verdicts',
      items: data.exchanges,
      value: judgedVerdictOrNull,
      atOf: (line) => line.arrivedAt,
      source: LAYOUT.exchanges,
    }),
    {
      name: 'gate_waits_at_limit_percent',
      places: 2,
      at: (minute) => {
        const { atLimit, judged } = gateWaitCounts(exchanges.get(minute) ?? []);
        return percentOrNull(atLimit, judged);
      },
    },
  ];
}

import { judgedVerdictOrNull } from '@ari/lib/api/schemas/appRecords/records';
import { DIMENSIONS, NAMESPACES, SIGNALS, type Signal } from '@ari/lib/metrics/catalogue';
import { type MetricGroup, measureOf, metricFields } from '@ari/lib/metrics/emf';
import type { AppRecord, JobRecord } from './records';

/** A figure a record may not carry; one it lacks is not published. */
const published = (signal: Signal, value: number | null) =>
  value === null ? [] : [measureOf(signal, value)];

/** How long a job waited from when it was due until a worker began it; null if either moment cannot be read. */
function jobWaitMs(record: JobRecord) {
  const waited = Date.parse(record.startedAt) - Date.parse(record.queuedAt);
  return Number.isFinite(waited) ? Math.max(0, waited) : null;
}

type ExchangeRecord = Extract<AppRecord, { kind: 'exchange' }>;

/** How many gate waits an exchange had that hit their limit: 1 or 0, or null when it had no verdict judged. */
function gateWaitsAtLimitCount(record: ExchangeRecord): number | null {
  if (record.outcome === 'gate-pending') return 1;
  return judgedVerdictOrNull(record) === null ? null : 0;
}

/** The figures a record publishes as metrics. */
function groupsOf(record: AppRecord): MetricGroup[] {
  switch (record.kind) {
    case 'state':
      return [
        {
          measures: [
            ...published(SIGNALS.app.pushStreamsOpenAverage, record.pushStreamsOpen),
            ...published(SIGNALS.app.oldestJobWaitMs, record.oldestJobWaitMs),
            ...published(SIGNALS.app.eventLoopDelayP99Ms, record.eventLoopDelayP99Ms),
            ...published(SIGNALS.app.heapUsedBytes, record.heapUsedBytes),
            ...published(SIGNALS.app.residentBytes, record.residentBytes),
            ...published(SIGNALS.app.dbConnectionsInUse, record.dbConnectionsInUse),
            ...published(SIGNALS.app.dbConnectionsWaiting, record.dbConnectionsWaiting),
            ...published(SIGNALS.app.workerSlotsBusy, record.workerSlotsBusy),
            ...published(SIGNALS.app.pushBusFailures, record.pushBusFailures),
          ],
        },
      ];
    case 'request':
      return [];
    case 'job':
      return [
        {
          dimensions: { [DIMENSIONS.task]: record.task },
          measures: published(SIGNALS.app.jobsRun, 1),
        },
        { measures: published(SIGNALS.app.jobWaitP50, jobWaitMs(record)) },
      ];
    case 'exchange': {
      const verdict = judgedVerdictOrNull(record);
      return [
        verdict === null
          ? { measures: [] }
          : {
              dimensions: { [DIMENSIONS.verdict]: verdict },
              measures: published(SIGNALS.app.gateVerdicts, 1),
            },
        { measures: published(SIGNALS.app.gateWaitsAtLimit, gateWaitsAtLimitCount(record)) },
      ];
    }
  }
}

/** The fields that make a record's log line also publish its figures as metrics. */
export function metricFieldsOf(record: AppRecord, at: Date): Record<string, unknown> {
  return metricFields(NAMESPACES.app, at, groupsOf(record));
}

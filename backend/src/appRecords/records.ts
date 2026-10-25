import type {
  AppRecord,
  ExchangeRecord,
  JobRecord,
  RequestRecord,
  StateRecord,
} from '@ari/lib/api/schemas/appRecords/records';
import { env } from '../config/env';
import { logger } from '../logger';
import { copyName } from './copyName';
import { metricFieldsOf } from './metrics';

export type {
  AppRecord,
  ExchangeOutcome,
  ExchangeRecord,
  ExchangeVerdict,
  JobRecord,
  StateRecord,
} from '@ari/lib/api/schemas/appRecords/records';

/** A record as its writer gives it. The copy that wrote it is added as it is logged. */
type RecordToLog =
  | Omit<ExchangeRecord, 'copy'>
  | Omit<JobRecord, 'copy'>
  | Omit<RequestRecord, 'copy'>
  | Omit<StateRecord, 'copy'>;

/** Milliseconds to a tenth, which is finer than any pause the records are read for. */
export function roundedToTenthMs(ms: number) {
  return Math.round(ms * 10) / 10;
}

/** Milliseconds since a monotonic reading, to a tenth. */
export function elapsedMsSince(began: number) {
  return roundedToTenthMs(performance.now() - began);
}

/**
 * Logs a record as one line of the app log, in every environment, naming
 * the copy of the backend that wrote it. The record sits under its own key
 * so a reader can pick it out from the rest of the log. Where metrics are
 * published, the same line also carries the record's figures as metric
 * fields.
 */
export function logAppRecord(given: RecordToLog) {
  const record: AppRecord = { ...given, copy: copyName() };
  const metrics = env.PUBLISH_METRICS ? metricFieldsOf(record, new Date()) : {};
  logger.info({ appRecord: record, ...metrics }, 'app record');
}

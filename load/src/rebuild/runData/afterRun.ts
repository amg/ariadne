import type { Manifest } from '../../records/index.ts';
import type { AfterRun, AppRecords } from '../types.ts';

/**
 * Splits the backend's records at the run's end: those of the run itself,
 * and, when the run kept a stretch after its end, those of the stretch. A
 * run that kept none has all its records in the run.
 */
export function splitAtRunEnd(
  manifest: Pick<Manifest, 'endedAt' | 'trailingEndsAt'>,
  records: AppRecords,
): { inRun: AppRecords; afterRun: AfterRun | null } {
  const { endedAt, trailingEndsAt } = manifest;
  if (endedAt === null || trailingEndsAt === null) return { inRun: records, afterRun: null };
  const within = <Item>(items: readonly Item[] | null, atOf: (item: Item) => string) => ({
    inRun: items?.filter((item) => atOf(item) <= endedAt) ?? null,
    after: items?.filter((item) => atOf(item) > endedAt) ?? null,
  });
  const exchanges = within(records.exchanges, (line) => line.arrivedAt);
  const jobs = within(records.jobs, (line) => line.startedAt);
  const requests = within(records.appRequests, (line) => line.endedAt);
  const states = within(records.appStates, (line) => line.at);
  return {
    inRun: {
      exchanges: exchanges.inRun,
      jobs: jobs.inRun,
      appRequests: requests.inRun,
      appStates: states.inRun,
    },
    afterRun: {
      from: endedAt,
      to: trailingEndsAt,
      exchanges: exchanges.after,
      jobs: jobs.after,
      appRequests: requests.after,
      appStates: states.after,
    },
  };
}

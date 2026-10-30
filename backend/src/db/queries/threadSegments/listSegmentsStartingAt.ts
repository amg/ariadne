import { db } from '@db/db';
import { tagQuery } from '@db/queryTag';

type ListSegmentsStartingAtProps = {
  /** The arrivals' user Messages. */
  startMessageIds: readonly string[];
  /** Which model's chain to read — one chain per embedding model runs. */
  modelId: string;
};

/** The segments that start at the given arrivals under one embedding model. No arrivals yield an empty list. */
export async function listSegmentsStartingAt({
  startMessageIds,
  modelId,
}: ListSegmentsStartingAtProps) {
  if (startMessageIds.length === 0) return [];
  return db
    .withPlugin(tagQuery('threadSegments/listSegmentsStartingAt'))
    .selectFrom('analysis.threadSegments')
    .select(['id', 'startMessageId'])
    .where('startMessageId', 'in', [...startMessageIds])
    .where('modelId', '=', modelId)
    .execute();
}

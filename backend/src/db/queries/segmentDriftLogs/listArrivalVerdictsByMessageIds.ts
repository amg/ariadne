import { db } from '@db/db';
import { tagQuery } from '@db/queryTag';

type ListArrivalVerdictsByMessageIdsProps = {
  /** The arrivals' user Messages. */
  messageIds: readonly string[];
  /** The embedding model the judgments ran under. */
  modelId: string;
};

/**
 * The stored verdicts of the given arrivals under one embedding model:
 * the segment each was judged in, the verdict, and what a fire caught. No
 * arrivals yield an empty list.
 */
export async function listArrivalVerdictsByMessageIds({
  messageIds,
  modelId,
}: ListArrivalVerdictsByMessageIdsProps) {
  if (messageIds.length === 0) return [];
  return db
    .withPlugin(tagQuery('segmentDriftLogs/listArrivalVerdictsByMessageIds'))
    .selectFrom('analysis.segmentDriftLogs')
    .select(['messageId', 'segmentId', 'verdict', 'fireChannel', 'slowDriftStartMessageId'])
    .where('messageId', 'in', [...messageIds])
    .where('modelId', '=', modelId)
    .execute();
}

import { db } from '@db/db';
import type { SegmentDriftLog } from '@db/types';

type FindSegmentDriftLogByMessageIdProps = {
  messageId: string;
  /** Which embedding model the judgment ran under. */
  modelId: string;
};

/**
 * The arrival's recorded verdict under one embedding model; null when no
 * verdict has been logged for the arrival yet.
 */
export async function findSegmentDriftLogByMessageId({
  messageId,
  modelId,
}: FindSegmentDriftLogByMessageIdProps): Promise<SegmentDriftLog | null> {
  const row = await db
    .selectFrom('analysis.segmentDriftLogs')
    .selectAll()
    .where('messageId', '=', messageId)
    .where('modelId', '=', modelId)
    .executeTakeFirst();
  return row ?? null;
}

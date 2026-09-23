import { db } from '@db/db';

type DeleteSegmentDriftLogsByMessageIdsProps = {
  messageIds: string[];
};

/**
 * Drops the arrival verdict rows for the given messages — used when a
 * message edit invalidates that message's signals and everything after it.
 * Chain re-fill recreates them on the next arrival or
 * analysis view. Returns the number deleted.
 */
export async function deleteSegmentDriftLogsByMessageIds({
  messageIds,
}: DeleteSegmentDriftLogsByMessageIdsProps): Promise<number> {
  if (messageIds.length === 0) return 0;
  const result = await db
    .deleteFrom('segmentDriftLogs')
    .where('messageId', 'in', messageIds)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}

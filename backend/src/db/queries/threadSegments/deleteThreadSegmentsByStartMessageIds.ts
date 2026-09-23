import { db } from '@db/db';

type DeleteThreadSegmentsByStartMessageIdsProps = {
  startMessageIds: string[];
};

/**
 * Drops live-chain segments that START at one of the given messages; rows
 * logged against a deleted segment cascade away, while rows against
 * earlier segments (the valid part of the chain) survive. Returns the
 * number deleted.
 */
export async function deleteThreadSegmentsByStartMessageIds({
  startMessageIds,
}: DeleteThreadSegmentsByStartMessageIdsProps): Promise<number> {
  if (startMessageIds.length === 0) return 0;
  const result = await db
    .deleteFrom('threadSegments')
    .where('startMessageId', 'in', startMessageIds)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}

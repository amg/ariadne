import { db } from '@db/db';

type DeleteMessageEmbeddingsByMessageIdsProps = {
  messageIds: string[];
};

/**
 * Invalidates stored embedding rows (turn or arrival) for the given
 * messages — used when a message edit invalidates that message's signals
 * and everything after it. Returns the number deleted.
 */
export async function deleteMessageEmbeddingsByMessageIds({
  messageIds,
}: DeleteMessageEmbeddingsByMessageIdsProps): Promise<number> {
  if (messageIds.length === 0) return 0;
  const result = await db
    .deleteFrom('messageEmbeddings')
    .where('messageId', 'in', messageIds)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}

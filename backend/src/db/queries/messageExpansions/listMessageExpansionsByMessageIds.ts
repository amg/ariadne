import { db } from '@db/db';
import type { MessageExpansion } from '@db/types';

type ListMessageExpansionsByMessageIdsProps = {
  messageIds: string[];
};

/**
 * Stored rewrite outcomes for the given message ids. Empty input yields
 * an empty list (no query).
 */
export async function listMessageExpansionsByMessageIds({
  messageIds,
}: ListMessageExpansionsByMessageIdsProps): Promise<MessageExpansion[]> {
  if (messageIds.length === 0) return [];
  return db
    .selectFrom('analysis.messageExpansions')
    .selectAll()
    .where('messageId', 'in', messageIds)
    .orderBy('createdAt', 'asc')
    .execute();
}

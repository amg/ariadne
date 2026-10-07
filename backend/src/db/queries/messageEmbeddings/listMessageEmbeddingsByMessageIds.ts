import { db } from '@db/db';
import type { MessageEmbedding } from '@db/types';
import { toMessageEmbedding } from './embeddingMapping';

type ListMessageEmbeddingsByMessageIdsProps = {
  messageIds: string[];
};

/**
 * Stored embeddings for the given message ids, vectors
 * parsed to numbers. Empty input yields an empty list (no query).
 */
export async function listMessageEmbeddingsByMessageIds({
  messageIds,
}: ListMessageEmbeddingsByMessageIdsProps): Promise<MessageEmbedding[]> {
  if (messageIds.length === 0) return [];
  const rows = await db
    .selectFrom('analysis.messageEmbeddings')
    .selectAll()
    .where('messageId', 'in', messageIds)
    .execute();
  return rows.map(toMessageEmbedding);
}

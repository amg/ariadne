import { db } from '@db/db';
import type { MessageEmbedding } from '@db/types';

type ListMessageEmbeddingsByMessageIdsProps = {
  messageIds: string[];
};

/** pgvector text form `[0.1,-0.2,…]` → numbers. */
function parseVector(raw: string): number[] {
  return JSON.parse(raw) as number[];
}

/**
 * Stored Turn embeddings for the given message ids, vectors
 * parsed to numbers. Empty input yields an empty list (no query).
 */
export async function listMessageEmbeddingsByMessageIds({
  messageIds,
}: ListMessageEmbeddingsByMessageIdsProps): Promise<MessageEmbedding[]> {
  if (messageIds.length === 0) return [];
  const rows = await db
    .selectFrom('messageEmbeddings')
    .selectAll()
    .where('messageId', 'in', messageIds)
    .execute();
  return rows.map(({ expandedText, ...row }) => ({
    ...row,
    rewrittenText: expandedText,
    embedding: parseVector(row.embedding),
  }));
}

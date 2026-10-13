import { db } from '@db/db';
import type { MessageEmbedding } from '@db/types';
import { toMessageEmbedding } from './embeddingMapping';

type ListMessageEmbeddingsByMessageIdsProps = {
  messageIds: string[];
  /** Which model's rows to read — one chain per embedding model runs. */
  modelId: string;
};

/**
 * Stored embeddings for the given message ids under one embedding model,
 * vectors parsed to numbers. Empty input yields an empty list (no query).
 */
export async function listMessageEmbeddingsByMessageIds({
  messageIds,
  modelId,
}: ListMessageEmbeddingsByMessageIdsProps): Promise<MessageEmbedding[]> {
  if (messageIds.length === 0) return [];
  const rows = await db
    .selectFrom('analysis.messageEmbeddings')
    .selectAll()
    .where('messageId', 'in', messageIds)
    .where('modelId', '=', modelId)
    .execute();
  return rows.map(toMessageEmbedding);
}

import { db } from '@db/db';
import { tagQuery } from '@db/queryTag';
import { parseVector } from './embeddingMapping';

type ListStoredEmbeddingsProps = {
  /** The Messages to look for. */
  messageIds: readonly string[];
  /** The Messages, among them, whose vectors are wanted; the rest come back without one. */
  vectorsFor: readonly string[];
  /** The embedding model whose rows to read. */
  modelId: string;
};

/** A Message that has an embedding stored, with its vector when it was asked for. */
type StoredEmbedding = {
  messageId: string;
  /** Null when the vector was not asked for. */
  vectorOrNull: readonly number[] | null;
};

/**
 * Which of the given Messages have an embedding stored under one model,
 * with the vectors of only those asked for. A vector costs far more to
 * send and read than the fact that it exists, so a caller asks for the
 * few it needs. No Messages yield an empty list.
 */
export async function listStoredEmbeddings({
  messageIds,
  vectorsFor,
  modelId,
}: ListStoredEmbeddingsProps): Promise<StoredEmbedding[]> {
  if (messageIds.length === 0) return [];
  const rows = await db
    .withPlugin(tagQuery('messageEmbeddings/listStoredEmbeddings'))
    .selectFrom('analysis.messageEmbeddings')
    .select((eb) => [
      'messageId',
      (vectorsFor.length === 0
        ? eb.cast<string | null>(eb.val(null), 'text')
        : eb
            .case()
            .when('messageId', 'in', [...vectorsFor])
            .then(eb.cast<string>('embedding', 'text'))
            .else(null)
            .end()
      ).as('embedding'),
    ])
    .where('messageId', 'in', [...messageIds])
    .where('modelId', '=', modelId)
    .execute();
  return rows.map((row) => ({
    messageId: row.messageId,
    vectorOrNull: row.embedding === null ? null : parseVector(row.embedding),
  }));
}

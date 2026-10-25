import type { MessageEmbeddingStored } from '@db/types';

/**
 * Shared codec for the `message_embeddings` rows: every query on this
 * table moves vectors across the pgvector text boundary, so all callers
 * route through these two conversions instead of open-coding them.
 */

/** Numbers → pgvector text form `[0.1,-0.2,…]` (cast `::vector` in SQL). */
export function toVectorText(embedding: number[]) {
  return `[${embedding.join(',')}]`;
}

/** pgvector text form `[0.1,-0.2,…]` → numbers. */
export function parseVector(raw: string) {
  return JSON.parse(raw) as number[];
}

/** Stored row → domain shape (vector parsed to numbers). */
export function toMessageEmbedding(stored: MessageEmbeddingStored) {
  return { ...stored, embedding: parseVector(stored.embedding) };
}

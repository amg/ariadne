import type { MessageEmbedding, MessageEmbeddingStored } from '@db/types';

/**
 * Shared codec for the `message_embeddings` rows. Every query on this
 * table moves vectors across the pgvector text boundary and renames the
 * stored `expanded_text` column to the domain's `rewrittenText`, so all
 * four callers route through this one codec instead of open-coding it.
 */

/** Numbers → pgvector text form `[0.1,-0.2,…]` (cast `::vector` in SQL). */
export function toVectorText(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/** pgvector text form `[0.1,-0.2,…]` → numbers. */
export function parseVector(raw: string): number[] {
  return JSON.parse(raw) as number[];
}

/** Nullable number → decimal literal string (null passes straight through). */
export function toDecimalLiteral(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

/**
 * Stored row → domain shape. Parses the text vector (null passes through)
 * and projects the stored `expanded_text` onto the domain `rewrittenText`.
 */
export function toMessageEmbedding(stored: MessageEmbeddingStored): MessageEmbedding {
  const { expandedText, embedding, ...row } = stored;
  return {
    ...row,
    rewrittenText: expandedText,
    embedding: embedding === null ? null : parseVector(embedding),
  };
}

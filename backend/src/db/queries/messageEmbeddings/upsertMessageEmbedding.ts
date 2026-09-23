import { db } from '@db/db';
import type { MessageEmbedding, MessageEmbeddingStored, NewMessageEmbedding } from '@db/types';
import { sql } from 'kysely';

/** Numbers → pgvector text form `[0.1,-0.2,…]` (cast `::vector` in SQL). */
function toVectorText(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/** pgvector text form `[0.1,-0.2,…]` → numbers. */
function parseVector(raw: string): number[] {
  return JSON.parse(raw) as number[];
}

/**
 * Persist-upon-use write for Turn embeddings: each
 * Turn's row is upserted as soon as its embed call succeeds, so an
 * abort-and-resume never loses progress. On conflict the stored row is
 * replaced (provenance change — different embedding model); `created_at`
 * keeps the original first-embed time.
 *
 * Raw SQL because the pgvector `::vector` cast does not fit the query
 * builder's typed value expressions; raw templates bypass CamelCasePlugin,
 * so result aliases stay camelCase by hand (repo convention).
 */
export async function upsertMessageEmbedding(row: NewMessageEmbedding): Promise<MessageEmbedding> {
  const result = await sql<MessageEmbeddingStored>`
    insert into message_embeddings (message_id, embedding, model_id)
    values (${row.messageId}, ${toVectorText(row.embedding)}::vector, ${row.modelId})
    on conflict (message_id) do update
      set embedding = excluded.embedding,
          model_id = excluded.model_id
    returning
      message_id as "messageId",
      embedding,
      model_id as "modelId",
      expanded_text as "expandedText",
      embedding_cost_usd as "embeddingCostUsd",
      rewrite_cost_usd as "rewriteCostUsd",
      judge_cost_usd as "judgeCostUsd",
      created_at as "createdAt"
  `.execute(db);

  const stored = result.rows[0];
  if (!stored) throw new Error('message_embeddings upsert returned no row');
  const { expandedText, ...rest } = stored;
  return { ...rest, rewrittenText: expandedText, embedding: parseVector(stored.embedding) };
}

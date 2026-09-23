import { db } from '@db/db';
import type { MessageEmbedding, MessageEmbeddingStored, NewArrivalEmbedding } from '@db/types';
import { sql } from 'kysely';

/** Numbers → pgvector text form `[0.1,-0.2,…]` (cast `::vector` in SQL). */
function toVectorText(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/** pgvector text form `[0.1,-0.2,…]` → numbers. */
function parseVector(raw: string): number[] {
  return JSON.parse(raw) as number[];
}

/** Nullable number → decimal literal string (null passes straight through). */
function toNumeric(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

/**
 * Persist-upon-use write for an *arrival* embedding: the arriving user
 * Message's judged signal, embedded before inference. The row
 * keys to the user Message (turn rows key to the assistant); on conflict
 * the stored row is replaced (provenance change or invalidation re-fill).
 * `expanded_text` records the rewrite the vector came from; the per-step
 * costs ride their own columns and stay out of `message_usage`.
 *
 * Raw SQL because the pgvector `::vector` cast does not fit the query
 * builder's typed value expressions; raw templates bypass CamelCasePlugin,
 * so result aliases stay camelCase by hand (repo convention).
 */
export async function upsertArrivalEmbedding(row: NewArrivalEmbedding): Promise<MessageEmbedding> {
  const result = await sql<MessageEmbeddingStored>`
    insert into message_embeddings (
      message_id, embedding, model_id, expanded_text,
      embedding_cost_usd, rewrite_cost_usd, judge_cost_usd
    )
    values (
      ${row.messageId}, ${toVectorText(row.embedding)}::vector, ${row.modelId},
      ${row.rewrittenText ?? null}, ${toNumeric(row.embeddingCostUsd ?? null)},
      ${toNumeric(row.rewriteCostUsd ?? null)}, ${toNumeric(row.judgeCostUsd ?? null)}
    )
    on conflict (message_id) do update
      set embedding = excluded.embedding,
          model_id = excluded.model_id,
          expanded_text = excluded.expanded_text,
          embedding_cost_usd = excluded.embedding_cost_usd,
          rewrite_cost_usd = excluded.rewrite_cost_usd,
          judge_cost_usd = excluded.judge_cost_usd
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
  if (!stored) throw new Error('message_embeddings arrival upsert returned no row');
  const { expandedText, ...rest } = stored;
  return { ...rest, rewrittenText: expandedText, embedding: parseVector(stored.embedding) };
}

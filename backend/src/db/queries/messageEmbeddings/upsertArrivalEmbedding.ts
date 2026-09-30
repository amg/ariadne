import { db } from '@db/db';
import type { MessageEmbedding, MessageEmbeddingStored, NewArrivalEmbedding } from '@db/types';
import { sql } from 'kysely';
import { toDecimalLiteral, toMessageEmbedding, toVectorText } from './embeddingMapping';

/**
 * Persist-upon-use write for an *arrival* embedding: the arriving user
 * Message's judged signal, embedded before inference. The row
 * keys to the user Message (turn rows key to the assistant); on conflict
 * the stored row is replaced (provenance change or invalidation re-fill).
 * `expanded_text` records the rewrite the vector came from; the per-step
 * costs ride their own columns and stay out of `message_usage`.
 */
export async function upsertArrivalEmbedding(row: NewArrivalEmbedding): Promise<MessageEmbedding> {
  const result = await db
    .insertInto('messageEmbeddings')
    .values({
      messageId: row.messageId,
      embedding: sql`${toVectorText(row.embedding)}::vector`,
      modelId: row.modelId,
      expandedText: row.rewrittenText ?? null,
      expandOutcome: row.expandOutcome ?? null,
      embeddingCostUsd: toDecimalLiteral(row.embeddingCostUsd ?? null),
      rewriteCostUsd: toDecimalLiteral(row.rewriteCostUsd ?? null),
      judgeCostUsd: toDecimalLiteral(row.judgeCostUsd ?? null),
    })
    .onConflict((oc) =>
      oc.column('messageId').doUpdateSet({
        embedding: (eb) => eb.ref('excluded.embedding'),
        modelId: (eb) => eb.ref('excluded.modelId'),
        expandedText: (eb) => eb.ref('excluded.expandedText'),
        expandOutcome: (eb) => eb.ref('excluded.expandOutcome'),
        embeddingCostUsd: (eb) => eb.ref('excluded.embeddingCostUsd'),
        rewriteCostUsd: (eb) => eb.ref('excluded.rewriteCostUsd'),
        judgeCostUsd: (eb) => eb.ref('excluded.judgeCostUsd'),
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  return toMessageEmbedding(result);
}

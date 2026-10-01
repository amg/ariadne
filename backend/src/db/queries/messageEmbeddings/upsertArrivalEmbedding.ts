import { db } from '@db/db';
import type { MessageEmbedding, NewArrivalEmbedding } from '@db/types';
import { sql } from 'kysely';
import { toDecimalLiteral, toMessageEmbedding, toVectorText } from './embeddingMapping';

/**
 * Persist-upon-arrival write for an *arrival* embedding: the arriving user
 * Message's judged signal, embedded before reasoning. That row keys on the
 * user Message (turn rows key on the assistant). On conflict, the stored
 * row is replaced (provenance change or re-population via discard).
 * `expanded_text` records the rewrite that generated the vector. The
 * embedding step's spend rides along on that row as well (`embeddingCostUsd`).
 * The rewrite/judge spend lives in `message_expansion_costs`.
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
    })
    .onConflict((oc) =>
      oc.column('messageId').doUpdateSet({
        embedding: (eb) => eb.ref('excluded.embedding'),
        modelId: (eb) => eb.ref('excluded.modelId'),
        expandedText: (eb) => eb.ref('excluded.expandedText'),
        expandOutcome: (eb) => eb.ref('excluded.expandOutcome'),
        embeddingCostUsd: (eb) => eb.ref('excluded.embeddingCostUsd'),
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  return toMessageEmbedding(result);
}

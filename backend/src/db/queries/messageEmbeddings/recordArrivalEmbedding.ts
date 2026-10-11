import { db } from '@db/db';
import type { MessageEmbedding, NewArrivalEmbedding } from '@db/types';
import { sql } from 'kysely';
import { toDecimalLiteral, toMessageEmbedding, toVectorText } from './embeddingMapping';

/**
 * Records an *arrival* embedding: the arriving user Message's judged
 * signal, embedded before reasoning, on the row keyed to the user Message
 * (turn rows key on the assistant). The vector lands only while the row
 * holds none from this embedding model, so every pass over the arrival
 * judges the first vector stored. The call's spend is added to the row's
 * `embeddingCostUsd` either way, since it was paid either way. A row the
 * rewrite step already wrote keeps its rewrite. Returns the stored row.
 */
export async function recordArrivalEmbedding(row: NewArrivalEmbedding): Promise<MessageEmbedding> {
  const result = await db
    .insertInto('analysis.messageEmbeddings')
    .values({
      messageId: row.messageId,
      embedding: sql`${toVectorText(row.embedding)}::vector`,
      modelId: row.modelId,
      embeddingCostUsd: toDecimalLiteral(row.embeddingCostUsd ?? null),
    })
    .onConflict((oc) =>
      oc.column('messageId').doUpdateSet((eb) => {
        const vectorOwed = eb.or([
          eb('analysis.messageEmbeddings.embedding', 'is', null),
          eb('analysis.messageEmbeddings.modelId', '<>', eb.ref('excluded.modelId')),
        ]);
        const storedCost = eb.ref('analysis.messageEmbeddings.embeddingCostUsd');
        const addedCost = eb.ref('excluded.embeddingCostUsd');
        return {
          embedding: eb
            .case()
            .when(vectorOwed)
            .then(eb.ref('excluded.embedding'))
            .else(eb.ref('analysis.messageEmbeddings.embedding'))
            .end(),
          modelId: eb.ref('excluded.modelId'),
          // The sum when both are known, else whichever is known.
          embeddingCostUsd: eb.fn.coalesce(eb(storedCost, '+', addedCost), storedCost, addedCost),
        };
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  return toMessageEmbedding(result);
}

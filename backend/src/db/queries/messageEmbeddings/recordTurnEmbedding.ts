import { db } from '@db/db';
import type { MessageEmbedding, NewMessageEmbedding } from '@db/types';
import { sql } from 'kysely';
import { toMessageEmbedding, toVectorText } from './embeddingMapping';

/**
 * Records a Turn's embedding, written as soon as its embed call succeeds
 * so an abort-and-resume never loses progress. The vector lands only
 * while the row holds none from this embedding model: a row from another
 * model is replaced, but one from this model stays, so every pass folds
 * the first vector stored. `created_at` keeps the original first-embed
 * time. Returns the stored row.
 */
export async function recordTurnEmbedding(row: NewMessageEmbedding): Promise<MessageEmbedding> {
  const result = await db
    .insertInto('analysis.messageEmbeddings')
    .values({
      messageId: row.messageId,
      embedding: sql`${toVectorText(row.embedding)}::vector`,
      modelId: row.modelId,
    })
    .onConflict((oc) =>
      oc
        .column('messageId')
        .doUpdateSet({
          embedding: (eb) => eb.ref('excluded.embedding'),
          modelId: (eb) => eb.ref('excluded.modelId'),
        })
        .where((eb) =>
          eb.or([
            eb('analysis.messageEmbeddings.embedding', 'is', null),
            eb('analysis.messageEmbeddings.modelId', '<>', eb.ref('excluded.modelId')),
          ]),
        ),
    )
    .returningAll()
    .executeTakeFirst();
  if (result) return toMessageEmbedding(result);

  const stored = await db
    .selectFrom('analysis.messageEmbeddings')
    .selectAll()
    .where('messageId', '=', row.messageId)
    .executeTakeFirstOrThrow();
  return toMessageEmbedding(stored);
}

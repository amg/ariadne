import { db } from '@db/db';
import type { MessageEmbedding, MessageEmbeddingStored, NewMessageEmbedding } from '@db/types';
import { sql } from 'kysely';
import { toMessageEmbedding, toVectorText } from './embeddingMapping';

/**
 * Persist-upon-use write for Turn embeddings: each
 * Turn's row is upserted as soon as its embed call succeeds, so an
 * abort-and-resume never loses progress. On conflict the stored row is
 * replaced (provenance change — different embedding model); `created_at`
 * keeps the original first-embed time.
 */
export async function upsertMessageEmbedding(row: NewMessageEmbedding): Promise<MessageEmbedding> {
  const result = await db
    .insertInto('analysis.messageEmbeddings')
    .values({
      messageId: row.messageId,
      embedding: sql`${toVectorText(row.embedding)}::vector`,
      modelId: row.modelId,
    })
    .onConflict((oc) =>
      oc.column('messageId').doUpdateSet({
        embedding: (eb) => eb.ref('excluded.embedding'),
        modelId: (eb) => eb.ref('excluded.modelId'),
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  return toMessageEmbedding(result);
}

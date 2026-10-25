import { db } from '@db/db';
import { tagQuery } from '@db/queryTag';
import type { NewMessageEmbedding } from '@db/types';
import { addSideCost } from '@queries/messageSideCosts/addSideCost';
import { sql } from 'kysely';
import { toMessageEmbedding, toVectorText } from './embeddingMapping';

interface RecordMessageEmbeddingProps extends NewMessageEmbedding {
  /**
   * This call's spend in USD. Recorded whatever the row's fate — a pass
   * that pays for an embedding another pass stored first still counts —
   * accumulating onto the message's `embedding` side-cost row. Null when
   * the caller has no spend to record.
   */
  embeddingCostUsd?: number | null;
  /** The call's token count, when the provider reported one. */
  promptTokens?: number | null;
}

/**
 * Records a Message's embedding under one embedding model: the arriving
 * user Message's judged signal, or a completed Turn's state vector — the
 * same write either way. The row lands only while none exists for the
 * (message, model) pair: the first pass's vector stands for every pass,
 * and a model switch starts its own row instead of overwriting. Returns
 * the stored row, whichever pass wrote it.
 */
export async function recordMessageEmbedding(props: RecordMessageEmbeddingProps) {
  const inserted = await db
    .withPlugin(tagQuery('messageEmbeddings/recordMessageEmbedding'))
    .insertInto('analysis.messageEmbeddings')
    .values({
      messageId: props.messageId,
      modelId: props.modelId,
      embedding: sql`${toVectorText(props.embedding)}::vector`,
    })
    .onConflict((oc) => oc.columns(['messageId', 'modelId']).doNothing())
    .returningAll()
    .executeTakeFirst();
  const stored = inserted
    ? inserted
    : await db
        .selectFrom('analysis.messageEmbeddings')
        .selectAll()
        .where('messageId', '=', props.messageId)
        .where('modelId', '=', props.modelId)
        .executeTakeFirstOrThrow();

  if (props.embeddingCostUsd !== null && props.embeddingCostUsd !== undefined) {
    await addSideCost({
      messageId: props.messageId,
      kind: 'embedding',
      model: props.modelId,
      costUsd: props.embeddingCostUsd.toFixed(10),
      promptTokens: props.promptTokens ?? null,
      completionTokens: null,
    });
  }
  return toMessageEmbedding(stored);
}

import { db } from '@db/db';
import type { ExpandOutcome, MessageEmbedding } from '@db/types';
import { toMessageEmbedding } from './embeddingMapping';

export interface RecordMessageExpansionProps {
  messageId: string;
  modelId: string;
  /** The recorded end of the arrival's try at a rewrite; null when none was attempted. */
  expandOutcome: ExpandOutcome | null;
  /** The self-contained rewrite, when one landed; null on every other end. */
  expandedText: string | null;
}

/**
 * The rewrite step's one write for an arrival: the expansion outcome
 * rides the arrival row before any vector exists — the row is born here
 * with a null embedding, and the embed step fills the vector into the
 * same row later. Written only if the arrival has no row yet: a pass that
 * finds one already stored leaves it as it is. Returns the stored row,
 * whichever pass wrote it. The rewrite/judge spends land in
 * `message_side_costs`.
 */
export async function recordMessageExpansion(
  row: RecordMessageExpansionProps,
): Promise<MessageEmbedding> {
  const inserted = await db
    .insertInto('analysis.messageEmbeddings')
    .values({
      messageId: row.messageId,
      embedding: null,
      modelId: row.modelId,
      expandedText: row.expandedText ?? null,
      expandOutcome: row.expandOutcome,
    })
    .onConflict((oc) => oc.column('messageId').doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return toMessageEmbedding(inserted);

  const stored = await db
    .selectFrom('analysis.messageEmbeddings')
    .selectAll()
    .where('messageId', '=', row.messageId)
    .executeTakeFirstOrThrow();
  return toMessageEmbedding(stored);
}

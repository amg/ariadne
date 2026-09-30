import { db } from '@db/db';
import type { ExpandOutcome, MessageEmbedding, MessageEmbeddingStored } from '@db/types';
import { toDecimalLiteral, toMessageEmbedding } from './embeddingMapping';

export interface RecordMessageExpansionProps {
  messageId: string;
  modelId: string;
  /** The recorded end of the arrival's try at a rewrite; null when none was attempted. */
  expandOutcome: ExpandOutcome | null;
  /** The self-contained rewrite, when one landed; null on every other end. */
  expandedText: string | null;
  /** This arrival's rewrite spend summed across its attempts. */
  rewriteCostUsd: number | null;
  /** This arrival's trigger-judge spend, when the backstop ran. */
  judgeCostUsd: number | null;
}

/**
 * The rewrite step's one write for an arrival: the expansion outcome
 * rides the arrival row before any vector exists — the row is born here
 * with a null embedding, and the embed step fills the vector into the
 * same row later. On conflict the expansion columns are replaced
 * (a re-run of the step re-records its outcome); the stored vector and
 * its cost are never touched by this write.
 */
export async function recordMessageExpansion(
  row: RecordMessageExpansionProps,
): Promise<MessageEmbedding> {
  const result = await db
    .insertInto('messageEmbeddings')
    .values({
      messageId: row.messageId,
      embedding: null,
      modelId: row.modelId,
      expandedText: row.expandedText ?? null,
      expandOutcome: row.expandOutcome,
      rewriteCostUsd: toDecimalLiteral(row.rewriteCostUsd),
      judgeCostUsd: toDecimalLiteral(row.judgeCostUsd),
    })
    .onConflict((oc) =>
      oc.column('messageId').doUpdateSet({
        expandedText: (eb) => eb.ref('excluded.expandedText'),
        expandOutcome: (eb) => eb.ref('excluded.expandOutcome'),
        rewriteCostUsd: (eb) => eb.ref('excluded.rewriteCostUsd'),
        judgeCostUsd: (eb) => eb.ref('excluded.judgeCostUsd'),
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  return toMessageEmbedding(result);
}

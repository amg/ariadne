import { db } from '@db/db';
import type { ExpandOutcome } from '@db/types';

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
 * finds one already stored leaves it as it is. The rewrite/judge spends
 * land in `message_side_costs`.
 */
export async function recordMessageExpansion(row: RecordMessageExpansionProps): Promise<void> {
  await db
    .insertInto('analysis.messageEmbeddings')
    .values({
      messageId: row.messageId,
      embedding: null,
      modelId: row.modelId,
      expandedText: row.expandedText ?? null,
      expandOutcome: row.expandOutcome,
    })
    .onConflict((oc) => oc.column('messageId').doNothing())
    .execute();
}

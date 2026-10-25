import { db } from '@db/db';
import type { ExpandOutcome } from '@db/types';

interface RecordMessageExpansionProps {
  messageId: string;
  /** The recorded end of the arrival's try at a rewrite. */
  expandOutcome: ExpandOutcome;
  /** The self-contained rewrite, when one landed; null on every other end. */
  expandedText: string | null;
}

/**
 * The rewrite step's one write for an arrival: its reading's end state,
 * written once, before any vector exists. Written only if the arrival
 * has no row yet: a pass that finds one already stored leaves it as it
 * is. Returns the stored row, whichever pass wrote it. The rewrite's
 * spend lands in `message_side_costs`.
 */
export async function recordMessageExpansion(props: RecordMessageExpansionProps) {
  const inserted = await db
    .insertInto('analysis.messageExpansions')
    .values({
      messageId: props.messageId,
      expandOutcome: props.expandOutcome,
      expandedText: props.expandedText ?? null,
    })
    .onConflict((oc) => oc.column('messageId').doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return inserted;

  return db
    .selectFrom('analysis.messageExpansions')
    .selectAll()
    .where('messageId', '=', props.messageId)
    .executeTakeFirstOrThrow();
}

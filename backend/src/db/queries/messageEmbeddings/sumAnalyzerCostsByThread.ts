import { db } from '@db/db';
import { sql } from 'kysely';

/** Analyzer-pipeline spend totals for one thread, as decimal strings. */
export interface AnalyzerCostTotals {
  embeddingCostUsd: string;
  rewriteCostUsd: string;
  judgeCostUsd: string;
}

/**
 * Totals the analyzer pipeline's spend for a thread: the embedding,
 * rewrite, and judge costs persisted on the arrival embedding rows
 * (keyed to user messages). Turn embedding rows leave the cost columns
 * null, and threads the analyzer never touched have no rows at all —
 * both coalesce to exact zero sums. Results are decimal strings like
 * `message_usage.cost_usd`, cast to the same numeric(14,10) precision
 * the columns store.
 *
 * Raw SQL so the result aliases come back camelCase by hand (the
 * embedding queries' repo convention).
 */
export async function sumAnalyzerCostsByThread({
  threadId,
}: {
  threadId: string;
}): Promise<AnalyzerCostTotals> {
  const result = await sql<AnalyzerCostTotals>`
    select
      coalesce(sum(me.embedding_cost_usd), 0)::numeric(14,10) as "embeddingCostUsd",
      coalesce(sum(me.rewrite_cost_usd), 0)::numeric(14,10) as "rewriteCostUsd",
      coalesce(sum(me.judge_cost_usd), 0)::numeric(14,10) as "judgeCostUsd"
    from message_embeddings me
    inner join messages m on m.id = me.message_id
    where m.thread_id = ${threadId}
  `.execute(db);

  const totals = result.rows[0];
  if (!totals) throw new Error('message_embeddings cost sum returned no row');
  return totals;
}

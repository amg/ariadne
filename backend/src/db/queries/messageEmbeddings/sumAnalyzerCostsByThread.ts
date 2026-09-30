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
 */
export async function sumAnalyzerCostsByThread({
  threadId,
}: {
  threadId: string;
}): Promise<AnalyzerCostTotals> {
  const result = await db
    .selectFrom('messageEmbeddings as me')
    .innerJoin('messages as m', 'm.id', 'me.messageId')
    .where('m.threadId', '=', threadId)
    .select([
      sql<string>`coalesce(sum(me.embedding_cost_usd), 0)::numeric(14,10)`.as('embeddingCostUsd'),
      sql<string>`coalesce(sum(me.rewrite_cost_usd), 0)::numeric(14,10)`.as('rewriteCostUsd'),
      sql<string>`coalesce(sum(me.judge_cost_usd), 0)::numeric(14,10)`.as('judgeCostUsd'),
    ])
    .executeTakeFirst();

  if (!result) throw new Error('message_embeddings cost sum returned no row');
  return result;
}

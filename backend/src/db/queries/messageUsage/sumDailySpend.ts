import { db } from '@db/db';
import { sql } from 'kysely';

/**
 * The global daily spend budget gate: sums all provider-metered USD for
 * the current UTC day across the cost tables. This is the last defense
 * against fund loss — checked before any Exchange starts. Over budget →
 * 429 with Retry-After (seconds until UTC midnight).
 *
 * Includes estimated and interrupted rows — Postgres is the ledger, the
 * sum of recorded spend rows, so it survives restarts, crashes, and
 * replicas by construction.
 *
 * Sums all spend sources: chat (messageUsage), embeddings (messageEmbeddings),
 * and expansion costs (messageExpansionCosts: rewrite + judge).
 */
export async function sumDailySpend(): Promise<string> {
  const [chatResult, embeddingResult, expansionResult] = await Promise.all([
    // Chat exchange spend
    db
      .selectFrom('messageUsage')
      .select(sql<string>`coalesce(sum(cost_usd), 0)::numeric(14,10)`.as('total'))
      .where(
        sql<Date>`date_trunc('day', created_at at time zone 'UTC')`,
        '=',
        sql<Date>`date_trunc('day', now() at time zone 'UTC')`,
      )
      .executeTakeFirst(),
    // Embedding spend
    db
      .selectFrom('messageEmbeddings')
      .select(sql<string>`coalesce(sum(embedding_cost_usd), 0)::numeric(14,10)`.as('total'))
      .where(
        sql<Date>`date_trunc('day', created_at at time zone 'UTC')`,
        '=',
        sql<Date>`date_trunc('day', now() at time zone 'UTC')`,
      )
      .executeTakeFirst(),
    // Expansion costs (rewrite + judge)
    db
      .selectFrom('messageExpansionCosts')
      .select(sql<string>`coalesce(sum(cost_usd), 0)::numeric(14,10)`.as('total'))
      .where(
        sql<Date>`date_trunc('day', created_at at time zone 'UTC')`,
        '=',
        sql<Date>`date_trunc('day', now() at time zone 'UTC')`,
      )
      .executeTakeFirst(),
  ]);

  const chatTotal = chatResult?.total ?? '0';
  const embeddingTotal = embeddingResult?.total ?? '0';
  const expansionTotal = expansionResult?.total ?? '0';

  // Sum the three components as numeric strings
  const total = Number(chatTotal) + Number(embeddingTotal) + Number(expansionTotal);
  return total.toFixed(10);
}

/**
 * Returns seconds until UTC midnight for the Retry-After header.
 */
export function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const utcMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  );
  return Math.floor((utcMidnight.getTime() - now.getTime()) / 1000);
}

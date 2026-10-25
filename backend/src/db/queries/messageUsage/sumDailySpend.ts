import { db } from '@db/db';
import { sql } from 'kysely';

/**
 * The global daily spend budget gate: all provider-metered USD recorded
 * for the current UTC day across chat, embeddings and side calls
 * (rewrite, judge, and Fact capture). This is the last defense against
 * fund loss, checked before any Exchange starts.
 *
 * Includes estimated and interrupted spend, and spend whose messages
 * were deleted since. Postgres keeps the total as spend is recorded, so
 * it survives restarts, crashes, and replicas by construction, and
 * costs the same however much was spent today.
 */
export async function sumDailySpend() {
  const today = await db
    .selectFrom('billing.dailySpend')
    .select((eb) => eb.fn.sum<string>('costUsd').as('costUsd'))
    .where('day', '=', sql<Date>`(now() at time zone 'UTC')::date`)
    .executeTakeFirst();

  return Number(today?.costUsd ?? 0).toFixed(10);
}

/**
 * Returns seconds until UTC midnight for the Retry-After header.
 */
export function secondsUntilUtcMidnight() {
  const now = new Date();
  const utcMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  );
  return Math.floor((utcMidnight.getTime() - now.getTime()) / 1000);
}

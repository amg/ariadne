import { db } from '@db/db';
import type { FactCategory } from '@db/types';

type ListSeedableUserFactsProps = {
  userId: string;
  /** Categories kept out of Seeds. */
  blockedCategories: readonly FactCategory[];
  /** Every match when left out. */
  limit?: number;
};

/**
 * The user's current, unsuppressed Facts outside the blocked categories,
 * newest first by stated date, or by when they were noted when no date
 * was stated.
 */
export async function listSeedableUserFacts({
  userId,
  blockedCategories,
  limit,
}: ListSeedableUserFactsProps) {
  let query = db
    .selectFrom('memory.userFacts')
    .select(['content', 'category', 'validAt', 'createdAt'])
    .where('userId', '=', userId)
    .where('invalidAt', 'is', null)
    .where('suppressed', '=', false);
  if (blockedCategories.length > 0) {
    query = query.where('category', 'not in', [...blockedCategories]);
  }
  const ordered = query
    .orderBy((eb) => eb.fn.coalesce('validAt', 'createdAt'), 'desc')
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'asc');
  return (limit === undefined ? ordered : ordered.limit(limit)).execute();
}

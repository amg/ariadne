import { db } from '@db/db';
import type { FactCategory } from '@db/types';

export interface SeedableUserFact {
  content: string;
  category: FactCategory;
  validAt: Date;
}

type ListSeedableUserFactsProps = {
  userId: string;
  /** Categories kept out of Seeds. */
  blockedCategories: readonly FactCategory[];
  limit: number;
};

/**
 * The user's current, unsuppressed Facts outside the blocked categories,
 * the most recently true first.
 */
export async function listSeedableUserFacts({
  userId,
  blockedCategories,
  limit,
}: ListSeedableUserFactsProps): Promise<SeedableUserFact[]> {
  let query = db
    .selectFrom('userFacts')
    .select(['content', 'category', 'validAt'])
    .where('userId', '=', userId)
    .where('invalidAt', 'is', null)
    .where('suppressed', '=', false);
  if (blockedCategories.length > 0) {
    query = query.where('category', 'not in', [...blockedCategories]);
  }
  return query
    .orderBy('validAt', 'desc')
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();
}

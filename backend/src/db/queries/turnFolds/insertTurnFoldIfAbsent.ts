import { db } from '@db/db';
import type { NewTurnFold } from '@db/types';

type InsertTurnFoldIfAbsentProps = {
  /** The fold to store, keyed to the Turn's assistant Message and the model. */
  fold: NewTurnFold;
};

/**
 * Stores one folded Turn's checkpoint. Only the first writer's row
 * stands — two passes folding the same Turn from the same stored verdict
 * and vector compute the same values, so the conflict is the answer, not
 * a race. Returns the stored row, whichever pass wrote it.
 */
export async function insertTurnFoldIfAbsent({ fold }: InsertTurnFoldIfAbsentProps) {
  const inserted = await db
    .insertInto('analysis.turnFolds')
    .values(fold)
    .onConflict((oc) => oc.columns(['messageId', 'modelId']).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return inserted;
  return db
    .selectFrom('analysis.turnFolds')
    .selectAll()
    .where('messageId', '=', fold.messageId as string)
    .where('modelId', '=', fold.modelId as string)
    .executeTakeFirstOrThrow();
}

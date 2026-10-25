import { db } from '@db/db';

type FindArrivalJudgmentStateOrNullProps = {
  messageId: string;
  /** Which embedding model's chain the checkpoint belongs to. */
  modelId: string;
};

/**
 * One judged arrival's stored judgment state under one embedding model —
 * the baseline and patrol the next arrival is judged from. Null when the
 * arrival has no checkpoint: the caller rebuilds from the chain instead.
 */
export async function findArrivalJudgmentStateOrNull({
  messageId,
  modelId,
}: FindArrivalJudgmentStateOrNullProps) {
  const row = await db
    .selectFrom('analysis.arrivalJudgmentStates')
    .selectAll()
    .where('messageId', '=', messageId)
    .where('modelId', '=', modelId)
    .executeTakeFirst();
  return row ?? null;
}

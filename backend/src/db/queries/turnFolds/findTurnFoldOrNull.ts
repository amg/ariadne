import { db } from '@db/db';

type FindTurnFoldOrNullProps = {
  /** The Turn's assistant Message. */
  messageId: string;
  /** Which embedding model's chain the checkpoint belongs to. */
  modelId: string;
};

/**
 * One folded Turn's stored checkpoint under one embedding model — the
 * segment geometry the next arrival's judgment and fold start from.
 * Null when the Turn has no fold: a lagging fold task, or a Turn the
 * keep-two rule already retired.
 */
export async function findTurnFoldOrNull({ messageId, modelId }: FindTurnFoldOrNullProps) {
  const row = await db
    .selectFrom('analysis.turnFolds')
    .selectAll()
    .where('messageId', '=', messageId)
    .where('modelId', '=', modelId)
    .executeTakeFirst();
  return row ?? null;
}

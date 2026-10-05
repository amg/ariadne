import { db } from '@db/db';

type ReopenSegmentsOfAbandonedClosersProps = {
  threadId: string;
  modelId: string;
};

/**
 * Owes capture again for every captured segment whose only closing fires
 * came from arrivals since abandoned (edited away or handed over): the
 * segment is open again, and its later Turns must be captured when it next
 * closes. Returns how many segments reopened.
 */
export async function reopenSegmentsOfAbandonedClosers({
  threadId,
  modelId,
}: ReopenSegmentsOfAbandonedClosersProps): Promise<number> {
  const result = await db
    .updateTable('threadSegments')
    .set({ factsCapturedAt: null })
    .where('threadId', '=', threadId)
    .where('modelId', '=', modelId)
    .where('factsCapturedAt', 'is not', null)
    .where((eb) => {
      const closingFire = (abandoned: boolean) =>
        eb.exists(
          eb
            .selectFrom('segmentDriftLogs as l')
            .innerJoin('messages as closer', 'closer.id', 'l.messageId')
            .select('l.messageId')
            .whereRef('l.segmentId', '=', 'threadSegments.id')
            .where('l.verdict', '=', 'fire')
            .where('closer.abandoned', '=', abandoned),
        );
      return eb.and([closingFire(true), eb.not(closingFire(false))]);
    })
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

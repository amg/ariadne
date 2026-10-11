import { db } from '@db/db';
import type { NewSegmentDriftLog } from '@db/types';

/** A segment an arrival opens; the caller picks its id so the verdict can name it. */
export interface OpenedSegment {
  id: string;
  threadId: string;
  startMessageId: string;
  modelId: string;
}

type AppendArrivalVerdictProps = {
  /** Segments the arrival opens: the chain's first, or the one its fire starts. */
  openedSegments: OpenedSegment[];
  /** The arrival's verdict; null when only a missing segment is owed. */
  verdict: NewSegmentDriftLog | null;
};

/** Rolls the append back when another pass wrote first. */
class WrittenByAnotherPass extends Error {}

/**
 * Adds one arrival's judgment to the live chain: its verdict and the
 * segments it opens, together or not at all. False, with nothing written,
 * when another pass already logged that verdict or opened one of those
 * segments.
 */
export async function appendArrivalVerdict({
  openedSegments,
  verdict,
}: AppendArrivalVerdictProps): Promise<boolean> {
  try {
    await db.transaction().execute(async (trx) => {
      if (openedSegments.length > 0) {
        const opened = await trx
          .insertInto('analysis.threadSegments')
          .values(openedSegments)
          .onConflict((oc) => oc.columns(['threadId', 'startMessageId', 'modelId']).doNothing())
          .returning('id')
          .execute();
        if (opened.length < openedSegments.length) throw new WrittenByAnotherPass();
      }
      if (verdict === null) return;
      const logged = await trx
        .insertInto('analysis.segmentDriftLogs')
        .values(verdict)
        .onConflict((oc) => oc.columns(['messageId', 'modelId']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!logged) throw new WrittenByAnotherPass();
    });
    return true;
  } catch (error) {
    if (error instanceof WrittenByAnotherPass) return false;
    throw error;
  }
}

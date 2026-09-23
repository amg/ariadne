import { db } from '@db/db';
import type { NewSegmentDriftLog, SegmentDriftLog } from '@db/types';

/**
 * Logs one judged arrival into the live chain: the composite reading
 * judged, the segment ledger's µ/σ/z snapshot before the arrival joined
 * it, and the verdict. Muted strides keep a row with null numbers so the
 * chain stays one-row-per-arrival.
 */
export async function insertSegmentDriftLog(row: NewSegmentDriftLog): Promise<SegmentDriftLog> {
  const inserted = await db
    .insertInto('segmentDriftLogs')
    .values({
      segmentId: row.segmentId,
      messageId: row.messageId,
      driftP: row.driftP ?? null,
      mu: row.mu ?? null,
      sigma: row.sigma ?? null,
      zScore: row.zScore ?? null,
      verdict: row.verdict,
      fireChannel: row.fireChannel ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return inserted;
}

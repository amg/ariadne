import { db } from '@db/db';

export interface UncapturedClosedSegment {
  segmentId: string;
  /** First user Message of the segment. */
  startMessageId: string;
  /** The live Boundary arrival that closed the segment (the latest, when several did). */
  closingMessageId: string;
}

type ListUncapturedClosedSegmentsProps = {
  threadId: string;
  modelId: string;
};

/**
 * The thread's live segments a fire has closed whose Fact capture is still
 * owed, oldest first. Only live arrivals count: a segment whose start was
 * abandoned is gone, and a fire from an abandoned arrival closes nothing.
 */
export async function listUncapturedClosedSegments({
  threadId,
  modelId,
}: ListUncapturedClosedSegmentsProps): Promise<UncapturedClosedSegment[]> {
  const rows = await db
    .selectFrom('threadSegments as s')
    .innerJoin('segmentDriftLogs as l', 'l.segmentId', 's.id')
    .innerJoin('messages as opener', 'opener.id', 's.startMessageId')
    .innerJoin('messages as closer', 'closer.id', 'l.messageId')
    .where('s.threadId', '=', threadId)
    .where('opener.abandoned', '=', false)
    .where('closer.abandoned', '=', false)
    .where('s.modelId', '=', modelId)
    .where('s.factsCapturedAt', 'is', null)
    .where('l.verdict', '=', 'fire')
    .select(['s.id as segmentId', 's.startMessageId', 'l.messageId as closingMessageId'])
    .orderBy('s.createdAt', 'asc')
    .orderBy('l.createdAt', 'asc')
    .execute();

  const latestBySegment = new Map<string, UncapturedClosedSegment>();
  for (const row of rows) latestBySegment.set(row.segmentId, row);
  return [...latestBySegment.values()];
}

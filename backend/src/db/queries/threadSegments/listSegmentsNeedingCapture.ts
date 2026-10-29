import { db } from '@db/db';
import { sql } from 'kysely';

type ListProps = {
  threadId: string;
  /** Which model's chain to read — one chain per embedding model runs. */
  modelId: string;
};

/**
 * The owed captures of the segments `where` picks, in chain order, in one
 * read. A segment owes one when its latest live fire sits past its
 * pointer. A segment whose fire died has none, so it is open again and
 * draws Turns until its next fire. The capture reads the Turns up to the
 * settle Message, not including it, and moves the pointer
 * (`capturedThroughAt`, null before a first pass) to that Message's time.
 */
function owedCaptures(where: { threadId: string } | { segmentId: string }, modelId: string) {
  const query = db
    .selectFrom('analysis.threadSegments as s')
    .innerJoinLateral(
      (eb) =>
        eb
          .selectFrom('analysis.segmentDriftLogs as l')
          .innerJoin('chat.messages as m', 'm.id', 'l.messageId')
          .whereRef('l.segmentId', '=', 's.id')
          .where('l.verdict', '=', 'fire')
          .where('m.abandoned', '=', false)
          // The pointer is written from a JavaScript date, which keeps milliseconds only.
          .select(['m.id', sql<Date>`date_trunc('milliseconds', m.created_at)`.as('at')])
          .orderBy('m.createdAt', 'desc')
          .orderBy('m.id', 'desc')
          .limit(1)
          .as('fire'),
      (join) => join.onTrue(),
    )
    .leftJoin('memory.memoryCaptureProgress as p', 'p.segmentId', 's.id')
    .where('s.modelId', '=', modelId)
    .where((eb) =>
      eb.or([
        eb('p.capturedThroughAt', 'is', null),
        eb('fire.at', '>', eb.ref('p.capturedThroughAt')),
      ]),
    )
    .select([
      's.id as segmentId',
      's.startMessageId',
      'p.capturedThroughAt',
      'fire.id as settleMessageId',
      'fire.at as settleMessageAt',
    ])
    .orderBy('s.createdAt', 'asc')
    .orderBy('s.id', 'asc');
  return 'threadId' in where
    ? query.where('s.threadId', '=', where.threadId)
    : query.where('s.id', '=', where.segmentId);
}

/**
 * The thread's segments whose Fact capture is still owed, oldest first.
 * Later Turns reopen a segment's owing through its next fire, and only
 * they get read.
 */
export async function listSegmentsNeedingCapture({ threadId, modelId }: ListProps) {
  return owedCaptures({ threadId }, modelId).execute();
}

/**
 * One segment's owed capture, as `listSegmentsNeedingCapture` would list
 * it, or null when it owes none or is gone. Its cost does not grow with
 * the thread.
 */
export async function findSegmentNeedingCaptureOrNull({
  segmentId,
  modelId,
}: {
  segmentId: string;
  modelId: string;
}) {
  return (await owedCaptures({ segmentId }, modelId).executeTakeFirst()) ?? null;
}

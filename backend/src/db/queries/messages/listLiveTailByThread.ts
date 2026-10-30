import { db } from '@db/db';
import { tagQuery } from '@db/queryTag';

/** How many live arrivals the tail holds at least, counting back from its target. */
const TAIL_ARRIVALS = 3;

type ListLiveTailByThreadProps = {
  threadId: string;
  /** The user Message the tail ends at, with its reply; null for the Thread's newest live arrival. */
  arrivalId: string | null;
  /** The embedding model whose verdicts count. */
  modelId: string;
};

/**
 * The live tail of a Thread, oldest first: the newest few live arrivals at
 * or before the target, reaching back further when needed to hold the
 * newest completed Turn before the target, through to the target's reply.
 * Beside it, about the live arrivals before the tail: how many there are,
 * how many completed a Turn, and whether one has no verdict under the
 * model. Everything is read as one snapshot of the Thread. A target that
 * is not a live arrival of the Thread yields an empty tail.
 */
export async function listLiveTailByThread({
  threadId,
  arrivalId,
  modelId,
}: ListLiveTailByThreadProps) {
  const tagged = db.withPlugin(tagQuery('messages/listLiveTailByThread'));
  const liveRows = tagged
    .selectFrom('chat.messages')
    .where('threadId', '=', threadId)
    .where('abandoned', '=', false);
  const liveArrivals = liveRows.where('role', '=', 'user');
  const targetAt =
    arrivalId === null
      ? liveArrivals.select((eb) => eb.fn.max('createdAt').as('createdAt'))
      : liveArrivals.select('createdAt').where('id', '=', arrivalId);
  const newestArrivalsStartAt = tagged
    .selectFrom(
      liveArrivals
        .select('createdAt')
        .where('createdAt', '<=', targetAt)
        .orderBy('createdAt', 'desc')
        .limit(TAIL_ARRIVALS)
        .as('newest'),
    )
    .select((eb) => eb.fn.min('newest.createdAt').as('createdAt'));
  // The newest reply before the target completes the newest Turn, however
  // many unanswered arrivals came after it; its arrival is the newest one before it.
  const newestReplyAt = liveRows
    .where('role', '=', 'assistant')
    .where('createdAt', '<', targetAt)
    .select((eb) => eb.fn.max('createdAt').as('createdAt'));
  const newestTurnStartAt = liveArrivals
    .where('createdAt', '<', newestReplyAt)
    .select((eb) => eb.fn.max('createdAt').as('createdAt'));
  const tailStartAt = tagged.selectNoFrom((eb) =>
    eb.fn<Date>('least', [newestArrivalsStartAt, newestTurnStartAt]).as('createdAt'),
  );
  const nextArrivalAt = liveArrivals
    .select((eb) => eb.fn.min('createdAt').as('createdAt'))
    .where('createdAt', '>', targetAt);
  const arrivalsBefore = liveArrivals.where('createdAt', '<', tailStartAt);
  // Each live row before the tail, with the role of the live row after it:
  // an arrival followed by a reply completed its Turn.
  const rowsBefore = liveRows
    .select((eb) => [
      'role',
      eb.fn
        .agg<string | null>('lead', ['role'])
        .over((over) => over.orderBy('createdAt'))
        .as('nextRole'),
    ])
    .where('createdAt', '<', tailStartAt)
    .as('before');

  const rows = await tagged
    .selectFrom('chat.messages as m')
    .selectAll('m')
    .select((eb) => [
      arrivalsBefore
        .select(eb.cast<number>(eb.fn.countAll(), 'integer').as('count'))
        .as('arrivalsBefore'),
      eb
        .selectFrom(rowsBefore)
        .select(eb.cast<number>(eb.fn.countAll(), 'integer').as('count'))
        .where('before.role', '=', 'user')
        .where('before.nextRole', '=', 'assistant')
        .as('completedTurnsBefore'),
      eb
        .exists(
          arrivalsBefore
            .select('id')
            .where(({ not, exists, selectFrom }) =>
              not(
                exists(
                  selectFrom('analysis.segmentDriftLogs as l')
                    .select('l.messageId')
                    .whereRef('l.messageId', '=', 'chat.messages.id')
                    .where('l.modelId', '=', modelId),
                ),
              ),
            ),
        )
        .$castTo<boolean>()
        .as('unjudgedBefore'),
    ])
    .where('m.threadId', '=', threadId)
    .where('m.abandoned', '=', false)
    .where('m.createdAt', '>=', tailStartAt)
    .where((eb) => eb.or([eb(nextArrivalAt, 'is', null), eb('m.createdAt', '<', nextArrivalAt)]))
    .orderBy('m.createdAt', 'asc')
    .execute();

  const first = rows[0];
  return {
    messages: rows.map(
      ({ arrivalsBefore: _a, completedTurnsBefore: _c, unjudgedBefore: _u, ...message }) => message,
    ),
    before: {
      arrivals: first?.arrivalsBefore ?? 0,
      completedTurns: first?.completedTurnsBefore ?? 0,
      unjudged: first?.unjudgedBefore ?? false,
    },
  };
}

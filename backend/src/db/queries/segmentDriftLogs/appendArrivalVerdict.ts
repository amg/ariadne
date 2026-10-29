import { db } from '@db/db';
import type { Database, DbExecutor, NewArrivalJudgmentState, NewSegmentDriftLog } from '@db/types';
import type { Transaction } from 'kysely';

/** A segment an arrival opens; the caller picks its id so the verdict can name it. */
interface OpenedSegment {
  id: string;
  threadId: string;
  startMessageId: string;
  modelId: string;
}

/** The checkpoints one verdict commit keeps: the previous arrival's and its own. */
interface KeptCheckpoints {
  /** Judgment states kept, by their arrival's user Message. */
  stateMessageIds: readonly string[];
  /** Turn folds kept, by their Turn's assistant Message. */
  foldMessageIds: readonly string[];
}

type AppendArrivalVerdictProps = {
  threadId: string;
  /** Segments the arrival opens: the chain's first, or the one its fire starts. */
  openedSegments: OpenedSegment[];
  /** The arrival's verdict; null when only a missing segment is owed. */
  verdict: NewSegmentDriftLog | null;
  /** The arrival's judgment-state checkpoint; null when the arrival judged nothing new. */
  judgmentState: NewArrivalJudgmentState | null;
  /** The keep-two rule's survivors; every other checkpoint of the Thread and model is pruned. */
  keep: KeptCheckpoints;
};

/** Rolls the append back when another pass wrote first. */
class WrittenByAnotherPass extends Error {}

/** Rolls the append back when an arrival that would open a segment was abandoned. */
class OpenerAbandoned extends Error {}

/**
 * Prunes the Thread's checkpoints to the keep-two survivors: every
 * judgment state and turn fold of this Thread and model whose Message is
 * live and not kept. Abandoned arrivals keep theirs — their rows stay
 * correct for them, whatever became of the conversation around them.
 */
async function pruneCheckpoints(
  trx: DbExecutor,
  props: {
    threadId: string;
    modelId: string;
    keep: KeptCheckpoints;
  },
) {
  const { threadId, modelId, keep } = props;
  const states = [...new Set(keep.stateMessageIds)];
  const folds = [...new Set(keep.foldMessageIds)];
  if (states.length > 0) {
    await trx
      .deleteFrom('analysis.arrivalJudgmentStates as s')
      .using('chat.messages as m')
      .whereRef('s.messageId', '=', 'm.id')
      .where('m.threadId', '=', threadId)
      .where('m.abandoned', '=', false)
      .where('s.modelId', '=', modelId)
      .where('s.messageId', 'not in', states)
      .execute();
  }
  if (folds.length > 0) {
    await trx
      .deleteFrom('analysis.turnFolds as f')
      .using('chat.messages as m')
      .whereRef('f.messageId', '=', 'm.id')
      .where('m.threadId', '=', threadId)
      .where('m.abandoned', '=', false)
      .where('f.modelId', '=', modelId)
      .where('f.messageId', 'not in', folds)
      .execute();
  }
}

/** Adds one arrival's judgment inside the caller's transaction. */
async function storeJudgment(
  trx: Transaction<Database>,
  {
    openedSegments,
    verdict,
    judgmentState,
    keep,
    threadId,
    modelId,
  }: Required<Omit<AppendArrivalVerdictProps, 'verdict' | 'judgmentState'>> & {
    verdict: NewSegmentDriftLog | null;
    judgmentState: NewArrivalJudgmentState | null;
    threadId: string;
    modelId: string;
  },
) {
  if (openedSegments.length > 0) {
    // Locked so that an abandon either sees the segment and deletes it, or
    // commits first and leaves this pass to write nothing.
    const openerIds = [...new Set(openedSegments.map((segment) => segment.startMessageId))];
    const liveOpeners = await trx
      .selectFrom('chat.messages')
      .select('id')
      .where('id', 'in', openerIds)
      .where('abandoned', '=', false)
      .forShare()
      .execute();
    if (liveOpeners.length < openerIds.length) throw new OpenerAbandoned();
    const opened = await trx
      .insertInto('analysis.threadSegments')
      .values(openedSegments)
      .onConflict((oc) => oc.columns(['threadId', 'startMessageId', 'modelId']).doNothing())
      .returning('id')
      .execute();
    if (opened.length < openedSegments.length) throw new WrittenByAnotherPass();
  }
  if (verdict !== null) {
    const logged = await trx
      .insertInto('analysis.segmentDriftLogs')
      .values(verdict)
      .onConflict((oc) => oc.columns(['messageId', 'modelId']).doNothing())
      .returning('messageId')
      .executeTakeFirst();
    if (!logged) throw new WrittenByAnotherPass();
  }
  if (judgmentState !== null) {
    // Idempotent by construction: a pass that lost the verdict race
    // never reaches this write, and two replays store the same values.
    await trx
      .insertInto('analysis.arrivalJudgmentStates')
      .values(judgmentState)
      .onConflict((oc) => oc.columns(['messageId', 'modelId']).doNothing())
      .execute();
  }
  if (verdict !== null || judgmentState !== null) {
    await pruneCheckpoints(trx, { threadId, modelId, keep });
  }
}

/**
 * Adds one arrival's judgment to the live chain — its verdict, the
 * segments it opens, and its judgment-state checkpoint — together or not
 * at all, then prunes every other checkpoint of the Thread to the
 * keep-two survivors. Nothing is written when another pass already logged
 * that verdict or opened one of those segments, or when an arrival that
 * would open a segment has been abandoned; the outcome says which. The
 * state row itself is idempotent (both passes replay the same stored rows
 * into the same values), so only the verdict and the segments decide the
 * race.
 */
export async function appendArrivalVerdict({
  threadId,
  openedSegments,
  verdict,
  judgmentState,
  keep,
}: AppendArrivalVerdictProps) {
  const modelId = verdict?.modelId ?? judgmentState?.modelId ?? openedSegments[0]?.modelId;
  try {
    await db.transaction().execute(async (trx) => {
      if (modelId === undefined) return;
      await storeJudgment(trx, { openedSegments, verdict, judgmentState, keep, threadId, modelId });
    });
    return 'appended';
  } catch (error) {
    if (error instanceof WrittenByAnotherPass) return 'written-by-another-pass';
    if (error instanceof OpenerAbandoned) return 'opener-abandoned';
    throw error;
  }
}

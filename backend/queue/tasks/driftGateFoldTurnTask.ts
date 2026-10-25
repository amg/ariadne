import type { ThreadAnalysisMode } from '@ari/lib/api/schemas/threads/analysis';
import type { DbExecutor, QueuedJob } from '@db/types';
import { enqueueJob } from '@queries/queue/enqueueJob';
import { findJobByKey } from '@queries/queue/findJobByKey';
import { foldTurnOfReply } from '@services/threadAnalysis';
import { MAX_ATTEMPTS, TaskFailure } from '../errors';

const DRIFT_GATE_FOLD_TURN = 'driftGateFoldTurn';

/** The completed Turn to fold. */
interface DriftGateFoldTurnParams {
  threadId: string;
  /** The Turn's assistant Message. */
  messageId: string;
}

declare global {
  namespace GraphileWorker {
    interface Tasks {
      driftGateFoldTurn: DriftGateFoldTurnParams;
    }
  }
}

/** Queues the Turn's fold; a fold still waiting for the same Turn absorbs it. */
export function enqueueDriftGateFoldTurn(params: DriftGateFoldTurnParams, trx?: DbExecutor) {
  return enqueueJob(
    {
      task: DRIFT_GATE_FOLD_TURN,
      payload: { ...params },
      key: params.messageId,
      maxAttempts: MAX_ATTEMPTS,
    },
    trx,
  );
}

/** The Turn's fold in the queue; null when none is queued or it finished. */
export function findDriftGateFoldTurnJobOrNull(messageId: string): Promise<QueuedJob | null> {
  return findJobByKey({ task: DRIFT_GATE_FOLD_TURN, key: messageId });
}

/**
 * Folds one completed Turn into its checkpoint, off the next arrival's
 * critical path — the queue's copy of the work the next judgment would
 * otherwise do inline. Give-ups are answers, not failures: the next
 * arrival's judgment folds inline whatever this task left behind, so a
 * give-up costs nothing but time. Only a provider failure throws — the
 * fold is worth retrying, and the embedding it pays for is worth
 * recording.
 */
export async function foldTurn({
  turn,
  threadAnalysisMode,
}: {
  turn: DriftGateFoldTurnParams;
  threadAnalysisMode: ThreadAnalysisMode;
}) {
  const folded = await foldTurnOfReply({
    threadId: turn.threadId,
    replyMessageId: turn.messageId,
    mode: threadAnalysisMode,
  });
  if (folded.type === 'error') {
    throw new TaskFailure(folded.code, folded.message);
  }
}

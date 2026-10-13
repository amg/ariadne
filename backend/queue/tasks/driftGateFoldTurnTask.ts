import type { DbExecutor } from '@db/types';
import { enqueueJob } from '@queries/queue/enqueueJob';
import { type QueuedJob, findJobByKeyOrNull } from '@queries/queue/findJobByKey';
import { foldTurnOfReply } from '@services/threadAnalysis';
import { TaskFailure } from '../errors';

export const DRIFT_GATE_FOLD_TURN = 'driftGateFoldTurn';
const MAX_ATTEMPTS = 3;

/** The completed Turn to fold. */
export interface DriftGateFoldTurnParams {
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
export function enqueueDriftGateFoldTurn(
  params: DriftGateFoldTurnParams,
  trx?: DbExecutor,
): Promise<void> {
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
  return findJobByKeyOrNull({ task: DRIFT_GATE_FOLD_TURN, key: messageId });
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
export async function foldTurn(params: DriftGateFoldTurnParams): Promise<void> {
  const folded = await foldTurnOfReply({
    threadId: params.threadId,
    replyMessageId: params.messageId,
  });
  if (folded.type === 'error') {
    throw new TaskFailure(folded.code, folded.message);
  }
}

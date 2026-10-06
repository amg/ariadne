import type { DbExecutor } from '@db/types';
import { enqueueJob } from '@queries/queue/enqueueJob';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { autoTitleThread } from '@services/titlingService';
import { ErrorCodes } from '../../src/types/errorCodes';
import { TaskFailure } from '../errors';

export const THREAD_GENERATE_TITLE = 'threadGenerateTitle';
const MAX_ATTEMPTS = 3;

/** The Thread one titling is about. */
export interface ThreadGenerateTitleParams {
  userId: string;
  threadId: string;
  /** A forced titling names a Thread that already has a title. */
  forced: boolean;
}

declare global {
  namespace GraphileWorker {
    interface Tasks {
      threadGenerateTitle: ThreadGenerateTitleParams;
    }
  }
}

/** Queues a Thread's titling; a titling still waiting for it absorbs the request. */
export function enqueueThreadGenerateTitle(
  params: ThreadGenerateTitleParams,
  trx?: DbExecutor,
): Promise<void> {
  return enqueueJob(
    {
      task: THREAD_GENERATE_TITLE,
      payload: { ...params },
      key: params.threadId,
      maxAttempts: MAX_ATTEMPTS,
    },
    trx,
  );
}

/**
 * What one titling run concluded. `gone` means the Thread no longer exists
 * for its user, `settled` that nothing owed a title; neither is an error.
 */
export type ThreadTitleOutcome =
  | { kind: 'gone' }
  | { kind: 'settled' }
  | { kind: 'titled'; userId: string; threadId: string; title: string };

/**
 * Titles one Thread and reports what resulted. A Thread already titled is
 * left alone unless the titling is forced; a Thread gone meanwhile owes
 * nothing. Titling the same Thread twice changes nothing the second time.
 */
export async function titleThread({
  userId,
  threadId,
  forced,
}: ThreadGenerateTitleParams): Promise<ThreadTitleOutcome> {
  if (!forced) {
    const thread = await findThreadByIdAndUser({ userId, threadId });
    if (!thread) return { kind: 'gone' };
    if (thread.title) return { kind: 'settled' };
  }

  const outcome = await autoTitleThread(userId, threadId, forced);
  if (outcome.type === 'titled') return { kind: 'titled', userId, threadId, title: outcome.title };
  if (outcome.type === 'settled') return { kind: 'settled' };
  if (outcome.code === ErrorCodes.THREAD_NOT_FOUND) return { kind: 'gone' };
  throw new TaskFailure(outcome.code, outcome.message);
}

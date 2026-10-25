import { publish } from '@services/events';
import type { titleThread } from '../tasks/threadGenerateTitleTask';

type ThreadTitleOutcome = Awaited<ReturnType<typeof titleThread>>;

/** A Thread that received its title announces it, so open tabs settle it. */
export function whenThreadTitled(outcome: ThreadTitleOutcome): void {
  if (outcome.kind !== 'titled') return;
  publish({
    kind: 'thread-titled',
    userId: outcome.userId,
    threadId: outcome.threadId,
    title: outcome.title,
  });
}

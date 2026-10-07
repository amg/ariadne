import type { ThreadTitleOutcome } from '@queue/tasks/threadGenerateTitleTask';
import { publish } from '@services/events';

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

import type { ChatStatus } from 'ai';

/** Whether an exchange is under way: asked and not yet answered, or still streaming. */
export function isRunning(status: ChatStatus) {
  return status === 'submitted' || status === 'streaming';
}

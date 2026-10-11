import { env } from '@config/env';
import { findPendingReplyOrNull } from '@queries/messages/findPendingReplyOrNull';
import { type StopTarget, type Subscription, onStopRequested, requestStop } from '@services/events';
import type { ChatStreamHandle } from './submitChat';

/**
 * The exchanges this backend copy streams, keyed by thread: one exchange
 * per thread at a time, so the thread id identifies the running handle.
 * Each listens for its user's stop, wherever that stop is asked.
 */
const activeExchanges = new Map<string, { handle: ChatStreamHandle; stopListener: Subscription }>();

export function registerActiveExchange(target: StopTarget, handle: ChatStreamHandle): void {
  activeExchanges.get(target.threadId)?.stopListener.close();
  const stopListener = onStopRequested(target, () => handle.abort());
  activeExchanges.set(target.threadId, { handle, stopListener });
}

/** Clears only its own handle — a later start must never lose its mapping. */
export function clearActiveExchange(threadId: string, handle: ChatStreamHandle): void {
  const active = activeExchanges.get(threadId);
  if (active?.handle !== handle) return;
  active.stopListener.close();
  activeExchanges.delete(threadId);
}

/** Whether the Thread's newest reply is still streaming on some backend copy. */
async function exchangeRunningElsewhere(threadId: string): Promise<boolean> {
  const pending = await findPendingReplyOrNull({ threadId });
  if (!pending) return false;
  return Date.now() - pending.createdAt.getTime() <= env.EXCHANGE_STALENESS_MS;
}

/**
 * User stop: aborts the thread's live exchange, here at once or on the
 * backend copy streaming it. True when one was running. A stop lost on
 * its way to another copy lets that exchange run to its end.
 */
export async function stopThreadExchange(target: StopTarget): Promise<boolean> {
  const local = activeExchanges.get(target.threadId);
  if (local) {
    local.handle.abort();
    return true;
  }
  if (!(await exchangeRunningElsewhere(target.threadId))) return false;
  requestStop(target);
  return true;
}

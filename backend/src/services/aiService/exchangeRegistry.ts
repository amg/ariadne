import type { ChatStreamHandle } from './submitChat';

/**
 * The live exchanges, keyed by thread: one exchange per thread at a time
 * (enforced by the start guard), so the thread id identifies the running
 * handle for the user-stop path. Registration is process-local; harnesses
 * recover calls that outlive the process via the pending-row shutdown.
 */
const activeExchanges = new Map<string, ChatStreamHandle>();

export function registerActiveExchange(threadId: string, handle: ChatStreamHandle): void {
  activeExchanges.set(threadId, handle);
}

/** Clears only its own handle — a later start must never lose its mapping. */
export function clearActiveExchange(threadId: string, handle: ChatStreamHandle): void {
  if (activeExchanges.get(threadId) === handle) activeExchanges.delete(threadId);
}

/** User stop: abort the thread's live exchange. True when one was running. */
export function stopThreadExchange(threadId: string): boolean {
  const handle = activeExchanges.get(threadId);
  if (!handle) return false;
  handle.abort();
  return true;
}

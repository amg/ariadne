import type { Message } from '@/services/api';
import { updateMessage } from '@/services/api';
import type { useChat } from '@ai-sdk/react';
import type { RefObject } from 'react';
import { toast } from 'sonner';
import { isRunning } from '../isRunning';
import { sendThreadMessage } from './chatRegistry';
import { buildRetrySeed } from './utils';

/**
 * What the user can do to the thread's exchange: send a message, ask for
 * the last arrival's reply again, and edit a prompt. Each does nothing while
 * an exchange is running. `rows` are the settled rows; `onSettle` refetches
 * them; `dropIds` hides rows at once; `reasoningCache` holds the reasoning
 * of replies on screen.
 */
export function useChatActions({
  threadId,
  chat,
  rows,
  reasoningCache,
  dropIds,
  onSettle,
}: {
  threadId: string;
  chat: ReturnType<typeof useChat>;
  rows: Message[];
  reasoningCache: RefObject<Map<string, string>>;
  dropIds: (ids: readonly string[]) => void;
  onSettle: () => void;
}) {
  const send = (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || isRunning(chat.status)) return;
    sendThreadMessage(threadId, trimmed);
  };

  /**
   * Asks the server for the last arrival's reply again. `continueHere`
   * carries the user's choice to keep a Paused arrival in this thread;
   * without it, a Paused arrival only reports its pause again.
   */
  const retryLast = (override?: { messageId: string; content: string }, continueHere = false) => {
    if (isRunning(chat.status)) return;
    if (rows.length === 0) return;

    const plan = buildRetrySeed(rows, override);
    if (!plan) return;

    if (plan.toDrop.length > 0) dropIds(plan.toDrop);
    for (const id of plan.clearIds) {
      reasoningCache.current.delete(id);
    }

    chat.setMessages(plan.seeded);
    try {
      void chat.regenerate(continueHere ? { body: { choice: 'continue' } } : undefined);
    } catch {
      // No settled rows: nothing to retry.
    }
  };

  /**
   * Saves a prompt edit: the server abandons the old turn in place and
   * returns the fork; the exchange then regenerates from the fork. A
   * rejected edit is reported, and resolves false.
   */
  const editMessage = async (messageId: string, content: string): Promise<boolean> => {
    const trimmed = content.trim();
    if (!trimmed || isRunning(chat.status)) return false;
    try {
      const forked = await updateMessage(threadId, messageId, trimmed);
      onSettle(); // refetch: abandoned turn vanishes, the fork appears
      retryLast({ messageId: forked.id, content: trimmed });
      return true;
    } catch (error) {
      toast.error('Could not save the edit', {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  return { send, retryLast, editMessage };
}

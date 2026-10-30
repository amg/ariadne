import type { HandoverProgress } from '@/components/chat/types';
import { handOverArrival } from '@/services/api';
import type { useChat } from '@ai-sdk/react';
import { useEffect, useRef, useState } from 'react';
import { replyToStoredMessage } from './chatRegistry';
import { withoutMovedArrival } from './utils';

/** The pause before asking again for a handover still saving memory; the server holds each ask. */
const HANDOVER_RETRY_DELAY_MS = 1_000;

/**
 * Asks for the handover until the arrival has moved, asking again while
 * the old chat's memory is still being saved. Null once `stillWanted`
 * says nobody is waiting any more; nothing has moved then.
 */
async function movedArrivalOrNull({
  threadId,
  messageId,
  stillWanted,
}: {
  threadId: string;
  messageId: string;
  stillWanted: () => boolean;
}) {
  for (;;) {
    const outcome = await handOverArrival(threadId, messageId);
    if (outcome.kind === 'moved') return outcome.handover;
    if (!stillWanted()) return null;
    await new Promise((resolve) => setTimeout(resolve, HANDOVER_RETRY_DELAY_MS));
  }
}

/**
 * Moving a paused arrival to a fresh thread, and how far that has got.
 * `memory` is whether the deployment runs Memory, which a handover then
 * saves first. `onHandedOver` opens the fresh thread. `dropIds` hides the
 * arrival's row here at once.
 */
export function useHandover({
  threadId,
  memory,
  pausedMessageId,
  chat,
  onHandedOver,
  dropIds,
}: {
  threadId: string;
  memory: boolean;
  pausedMessageId: string | null;
  chat: ReturnType<typeof useChat>;
  onHandedOver: ((threadId: string) => void) | undefined;
  dropIds: (ids: readonly string[]) => void;
}) {
  const [handover, setHandover] = useState<HandoverProgress>('idle');
  const [handoverError, setHandoverError] = useState<string | null>(null);
  // A handover still saving memory keeps asking only while this view is up.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Moves the paused arrival to a fresh thread: the server opens it (seeded
   * from memory, once what this thread taught is saved) with the arrival
   * stored as its first message, whose reply is requested there before the
   * view switches over. Leaving this view stops asking again; an arrival
   * not moved by then stays here, paused, for the next try, and one that
   * moved meanwhile still gets its reply without pulling the user over.
   */
  const startNewChat = async () => {
    if (!pausedMessageId || handover !== 'idle') return;
    setHandover(memory ? 'saving-memory' : 'moving');
    setHandoverError(null);
    try {
      const moved = await movedArrivalOrNull({
        threadId,
        messageId: pausedMessageId,
        stillWanted: () => mountedRef.current,
      });
      if (!moved) return;
      // The arrival left this thread: hide its row now, and drop its live
      // copy from the thread's chat object, which outlives this view and
      // would otherwise render it again as an unsaved message.
      dropIds([pausedMessageId]);
      chat.setMessages(withoutMovedArrival(chat.messages, moved.message.content));
      replyToStoredMessage(moved.thread.id, moved.message);
      if (mountedRef.current) onHandedOver?.(moved.thread.id);
    } catch {
      setHandoverError('Could not start a new chat from this message. Try again.');
    } finally {
      setHandover('idle');
    }
  };

  return { handover, handoverError, startNewChat };
}

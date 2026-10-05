import {
  type Message,
  fetchResumeDraft,
  handOverArrival,
  stopThreadExchange,
  updateMessage,
} from '@/services/api';
import { useChat } from '@ai-sdk/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import ChatView from '../ChatView';
import type { RestoredDraft } from '../ChatView/types';
import {
  getThreadChat,
  replyToStoredMessage,
  sendThreadMessage,
  subscribeToThreadChat,
} from './chatRegistry';
import type { StreamVerdict, UiMessageLike } from './types';
import {
  buildRetrySeed,
  extractReasoning,
  lastUserMessage,
  mergeDisplayRows,
  pausedArrivalIdOrNull,
  readVerdictData,
  withoutMovedArrival,
} from './utils';

type ChatControllerProps = {
  threadId: string;
  rows: Message[];
  onSettle: () => void;
  onGenerateTitle?: () => void;
  /** Opens the fresh thread a paused arrival was moved to. */
  onHandedOver?: (threadId: string) => void;
};

/**
 * Owns the live AI exchange for one thread: the thread's registry chat
 * object, optimistic + streaming rows merged over the settled loader rows,
 * and send/stop. Renders the pure ChatView. (The page only wires router
 * glue.) The chat object outlives this view — unmounting never stops the
 * exchange, and remounting reattaches to the live or settled stream.
 */
export default function ChatController({
  threadId,
  rows,
  onSettle,
  onGenerateTitle,
  onHandedOver,
}: ChatControllerProps) {
  // The chat object lives in the per-tab registry (module level), keyed by
  // thread; useChat attaches to it externally instead of owning one, so no
  // effect here can stop the exchange on unmount.
  const chat = useChat({ chat: getThreadChat(threadId) });

  const [droppedIds, setDroppedIds] = useState<Set<string>>(new Set());

  // The transient `data-thread-verdict` part arrives only through `onData`
  // (the SDK keeps it out of message.parts), so the verdict is held here and
  // applied to the pending user bubble before the reply grows.
  const [streamVerdict, setStreamVerdict] = useState<StreamVerdict | null>(null);
  const [restoredDraft, setRestoredDraft] = useState<RestoredDraft | null>(null);
  const [handingOver, setHandingOver] = useState(false);
  const [handoverError, setHandoverError] = useState<string | null>(null);
  const messagesRef = useRef<UiMessageLike[]>([]);

  // Settlement handlers keep the render's identity; the registry
  // subscription is tied to the thread alone.
  const settleRef = useRef({ onSettle, onGenerateTitle });
  useMemo(() => {
    settleRef.current = { onSettle, onGenerateTitle };
  }, [onSettle, onGenerateTitle]);

  // The registry fans exchange events to whichever view is subscribed.
  useEffect(() => {
    return subscribeToThreadChat(threadId, {
      // The verdict flows `onData` as the stream's first event: map it to the
      // pending arrival (the last user message) so the bubble tints before the
      // reply starts growing.
      onData: (part) => {
        if (part.type !== 'data-thread-verdict') return;
        const payload = readVerdictData(part);
        const arrival = lastUserMessage(messagesRef.current);
        if (!payload || !arrival) return;
        setStreamVerdict({ ...payload, userMessageId: arrival.id });
      },
      // After every stream end (including user stop) refetch rows so usage
      // metadata and persisted ids replace the optimistic/streaming state.
      onSettle: () => {
        setStreamVerdict(null);
        settleRef.current.onSettle();
        settleRef.current.onGenerateTitle?.();
      },
      // A failed submit puts the draft back in the input; recovery is a resend.
      onFailedSubmit: (draft) => {
        setRestoredDraft((prev) => ({ text: draft, nonce: (prev?.nonce ?? 0) + 1 }));
      },
    });
  }, [threadId]);

  // The thread's newest abandoned/failed exchange offers its arrival text
  // back for the input; fetched once per mount, a local draft wins.
  useEffect(() => {
    let cancelled = false;
    void fetchResumeDraft(threadId)
      .then((draft) => {
        if (cancelled || !draft) return;
        setRestoredDraft((prev) => prev ?? { text: draft.text, nonce: 0 });
      })
      .catch(() => {
        // No draft owed, or the API was unavailable — the input stays as-is.
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // Preserve reasoning across renders (even after stream completes)
  const reasoningCache = useRef<Map<string, string>>(new Map());

  // Update cache with any new reasoning from chat messages, and keep a
  // fresh snapshot for `onData` (which fires mid-stream, outside render).
  useMemo(() => {
    messagesRef.current = chat.messages;
    for (const msg of chat.messages) {
      if (msg.role === 'assistant') {
        const reasoning = extractReasoning(msg.parts);
        if (reasoning) reasoningCache.current.set(msg.id, reasoning);
      }
    }
  }, [chat.messages]);

  // Filter out dropped and abandoned rows before merging with chat messages:
  // abandoned rows stay in the DB (their usage keeps tracking what the
  // thread burned), but never render.
  const visibleRows = useMemo(
    () => rows.filter((row) => !droppedIds.has(row.id) && !row.abandoned),
    [rows, droppedIds],
  );

  // The purple bubble: the transient verdict arrives through `onData` before
  // the reply grows, so the merge keys it to the arrival's optimistic row;
  // after settle the loader rows carry the persisted verdicts instead.
  const liveVerdict = streamVerdict;

  const display = useMemo(
    () =>
      mergeDisplayRows(
        visibleRows,
        chat.messages,
        chat.status,
        reasoningCache.current,
        liveVerdict,
      ),
    [visibleRows, chat.messages, chat.status, liveVerdict],
  );

  const pausedMessageId = pausedArrivalIdOrNull(display, visibleRows, chat.status);

  /**
   * Moves the paused arrival to a fresh thread: the server opens it (seeded
   * from memory) with the arrival stored as its first message, whose reply
   * is requested there before the view switches over.
   */
  const startNewChat = async () => {
    if (!pausedMessageId || handingOver) return;
    setHandingOver(true);
    setHandoverError(null);
    try {
      const handover = await handOverArrival(threadId, pausedMessageId);
      // The arrival left this thread: hide its row now, and drop its live
      // copy from the thread's chat object, which outlives this view and
      // would otherwise render it again as an unsaved message.
      setDroppedIds((prev) => new Set([...prev, pausedMessageId]));
      chat.setMessages(withoutMovedArrival(chat.messages, handover.message.content));
      replyToStoredMessage(handover.thread.id, handover.message);
      onHandedOver?.(handover.thread.id);
    } catch {
      setHandoverError('Could not start a new chat from this message. Try again.');
    } finally {
      setHandingOver(false);
    }
  };

  const send = (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || chat.status === 'submitted' || chat.status === 'streaming') return;
    sendThreadMessage(threadId, trimmed);
  };

  const retryLast = (override?: { messageId: string; content: string }) => {
    if (chat.status === 'submitted' || chat.status === 'streaming') return;
    if (rows.length === 0) return;

    const plan = buildRetrySeed(rows, override);
    if (!plan) return;

    if (plan.toDrop.length > 0) {
      setDroppedIds((prev) => new Set([...prev, ...plan.toDrop]));
    }
    for (const id of plan.clearIds) {
      reasoningCache.current.delete(id);
    }

    chat.setMessages(plan.seeded);
    try {
      void chat.regenerate();
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
    if (!trimmed || chat.status === 'submitted' || chat.status === 'streaming') return false;
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

  return (
    <ChatView
      rows={display}
      status={chat.status}
      errorMessage={handoverError ?? chat.error?.message ?? null}
      restoredDraft={restoredDraft}
      onSend={send}
      onStop={() => {
        chat.stop();
        void stopThreadExchange(threadId).catch(() => {});
      }}
      onRetryLast={() => retryLast()}
      onEditMessage={editMessage}
      pausedMessageId={pausedMessageId}
      handingOver={handingOver}
      onContinueHere={() => retryLast()}
      onStartNewChat={() => void startNewChat()}
    />
  );
}

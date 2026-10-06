import {
  type Handover,
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
import type { HandoverProgress, RestoredDraft } from '../ChatView/types';
import {
  type GateWaitOutcome,
  describeChatError,
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
  /** Whether the deployment runs Memory: a handover then saves the old chat's Facts first. */
  memory: boolean;
  onSettle: () => void;
  /** Opens the fresh thread a paused arrival was moved to. */
  onHandedOver?: (threadId: string) => void;
};

/** The pause before asking again for a handover still saving memory; the server holds each ask. */
const HANDOVER_RETRY_DELAY_MS = 1_000;

/**
 * Asks for the handover until the arrival has moved, asking again while
 * the old chat's memory is still being saved. Null once `stillWanted`
 * says nobody is waiting any more; nothing has moved then.
 */
async function movedArrivalOrNull(
  threadId: string,
  messageId: string,
  stillWanted: () => boolean,
): Promise<Handover | null> {
  for (;;) {
    const outcome = await handOverArrival(threadId, messageId);
    if (outcome.kind === 'moved') return outcome.handover;
    if (!stillWanted()) return null;
    await new Promise((resolve) => setTimeout(resolve, HANDOVER_RETRY_DELAY_MS));
  }
}

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
  memory,
  onSettle,
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
  // A submit that settled as a gate wait: the arrival is stored, its
  // judgment still owed. The bubble stays; a retry waits on it again.
  const [gateWait, setGateWait] = useState<GateWaitOutcome | null>(null);
  const [restoredDraft, setRestoredDraft] = useState<RestoredDraft | null>(null);
  const [handover, setHandover] = useState<HandoverProgress>('idle');
  const [handoverError, setHandoverError] = useState<string | null>(null);
  const messagesRef = useRef<UiMessageLike[]>([]);
  // A handover still saving memory keeps asking only while this view is up.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Settlement handlers keep the render's identity; the registry
  // subscription is tied to the thread alone.
  const settleRef = useRef({ onSettle });
  useMemo(() => {
    settleRef.current = { onSettle };
  }, [onSettle]);

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
      },
      // A failed submit puts the draft back in the input; recovery is a resend.
      onFailedSubmit: (draft) => {
        setRestoredDraft((prev) => ({ text: draft, nonce: (prev?.nonce ?? 0) + 1 }));
      },
      // A gate wait keeps the message on screen; its notice offers the retry.
      onGateWait: (outcome) => {
        setGateWait(outcome);
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

  // A gate wait ends when the next attempt starts: the retry itself, or a
  // fresh submit, takes the thread through the gate again. It also goes
  // once a fire lands on the arrival — the pause choice takes over.
  useEffect(() => {
    if (!gateWait) return;
    if (chat.status === 'submitted' || chat.status === 'streaming') {
      setGateWait(null);
      return;
    }
    const last = display[display.length - 1];
    if (last?.message.role === 'user' && last.verdict?.verdict === 'fire') {
      setGateWait(null);
    }
  }, [gateWait, chat.status, display]);

  // What the gate-wait notice says: still mid-judgment, judged clear and
  // ready for a reply, or the judgment gave up.
  const gateWaitKind = useMemo<'pending' | 'cleared' | 'failed' | null>(() => {
    if (!gateWait) return null;
    if (gateWait === 'gate_failed') return 'failed';
    const last = display[display.length - 1];
    const clear =
      last?.message.role === 'user' &&
      (last.verdict?.verdict === 'pass' || last.verdict?.verdict === 'muted');
    return clear ? 'cleared' : 'pending';
  }, [gateWait, display]);

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
      const moved = await movedArrivalOrNull(threadId, pausedMessageId, () => mountedRef.current);
      if (!moved) return;
      // The arrival left this thread: hide its row now, and drop its live
      // copy from the thread's chat object, which outlives this view and
      // would otherwise render it again as an unsaved message.
      setDroppedIds((prev) => new Set([...prev, pausedMessageId]));
      chat.setMessages(withoutMovedArrival(chat.messages, moved.message.content));
      replyToStoredMessage(moved.thread.id, moved.message);
      if (mountedRef.current) onHandedOver?.(moved.thread.id);
    } catch {
      setHandoverError('Could not start a new chat from this message. Try again.');
    } finally {
      setHandover('idle');
    }
  };

  const send = (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || chat.status === 'submitted' || chat.status === 'streaming') return;
    sendThreadMessage(threadId, trimmed);
  };

  /**
   * Asks the server for the last arrival's reply again. `continueHere`
   * carries the user's choice to keep a Paused arrival in this thread;
   * without it, a Paused arrival only reports its pause again.
   */
  const retryLast = (override?: { messageId: string; content: string }, continueHere = false) => {
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
      errorMessage={gateWait ? null : (handoverError ?? describeChatError(chat.error))}
      gateWait={gateWaitKind}
      restoredDraft={restoredDraft}
      onSend={send}
      onStop={() => {
        chat.stop();
        void stopThreadExchange(threadId).catch(() => {});
      }}
      onRetryLast={() => retryLast()}
      onEditMessage={editMessage}
      pausedMessageId={pausedMessageId}
      handover={handover}
      onContinueHere={() => retryLast(undefined, true)}
      onStartNewChat={() => void startNewChat()}
    />
  );
}

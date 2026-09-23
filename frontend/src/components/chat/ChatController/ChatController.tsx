import { type Message, updateMessage } from '@/services/api';
import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { DefaultChatTransport } from 'ai';
import { useMemo, useRef, useState } from 'react';
import ChatView from '../ChatView';
import type { StreamVerdict, UiMessageLike } from './types';
import {
  extractReasoning,
  findTargetUserMessageIndex,
  lastUserMessage,
  mergeDisplayRows,
  readVerdictData,
} from './utils';

type ChatControllerProps = {
  threadId: string;
  rows: Message[];
  onSettle: () => void;
  isNewChat?: boolean;
  onGenerateTitle?: () => void;
};

/**
 * Owns the live AI exchange for one thread: `useChat` transport, optimistic
 * + streaming rows merged over the settled loader rows, and send/stop.
 * Renders the pure ChatView. (The page only wires router glue.)
 */
export default function ChatController({
  threadId,
  rows,
  onSettle,
  isNewChat,
  onGenerateTitle,
}: ChatControllerProps) {
  // One transport per thread; the Outlet is keyed by threadId (AppLayout),
  // so useChat state is rebuilt on navigation and never leaks across threads.
  const transport = useMemo(
    () => new DefaultChatTransport({ api: `/api/threads/${threadId}/chat` }),
    [threadId],
  );

  const [droppedIds, setDroppedIds] = useState<Set<string>>(new Set());

  // The transient `data-thread-verdict` part arrives only through `onData`
  // (the SDK keeps it out of message.parts), so the verdict is held here and
  // applied to the pending user bubble before the reply grows.
  const [streamVerdict, setStreamVerdict] = useState<StreamVerdict | null>(null);
  const messagesRef = useRef<UiMessageLike[]>([]);

  // Keep track of the latest isNewChat value without re-triggering useChat options
  const isNewChatRef = useRef(isNewChat);
  useMemo(() => {
    isNewChatRef.current = isNewChat;
  }, [isNewChat]);

  const chat = useChat({
    id: threadId,
    transport,
    // The verdict flows `onData` as the stream's first event: map it to the
    // pending arrival (the last user message) so the bubble tints before the
    // reply starts growing. The verdict rides the gun-pipeline exchange, and
    // only `submit-message` triggers that — the last pending user row IS the
    // judged arrival.
    onData: (part) => {
      if ((part as { type?: string }).type !== 'data-thread-verdict') return;
      const payload = readVerdictData(part as { data?: unknown });
      const arrival = lastUserMessage(messagesRef.current);
      if (!payload || !arrival) return;
      setStreamVerdict({ ...payload, userMessageId: arrival.id });
    },
    // After every stream (including user stop) refetch rows so usage
    // metadata and persisted ids replace the optimistic/streaming state.
    onFinish: () => {
      setStreamVerdict(null);
      onSettle();
      if (onGenerateTitle) {
        onGenerateTitle();
      }
    },
    onError: () => {
      setStreamVerdict(null);
      onSettle();
      if (onGenerateTitle) {
        onGenerateTitle();
      }
    },
  });

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

  // Filter out dropped rows before merging with chat messages
  const visibleRows = useMemo(
    () => rows.filter((row) => !droppedIds.has(row.id)),
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

  const send = (content: string) => {
    if (!content.trim() || chat.status === 'submitted' || chat.status === 'streaming') return;
    chat.sendMessage({ role: 'user', parts: [{ type: 'text', text: content.trim() }] });
  };

  /**
   * Retry of the last inference (useChat `regenerate`). The server decides
   * the exchange from DB state; the client message list is only there to
   * satisfy the SDK's last-message guard, so always (re)seed it from the
   * settled loader rows — in-session optimistic state can diverge from the
   * DB (e.g. right after an edit). The override applies an edit that the
   * revalidator hasn't applied to `rows` yet.
   */
  const retryLast = (override?: { messageId: string; content: string }) => {
    if (chat.status === 'submitted' || chat.status === 'streaming') return;
    if (rows.length === 0) return;

    const lastUserIndex = findTargetUserMessageIndex(rows, override?.messageId);

    if (lastUserIndex >= 0) {
      // Optimistically hide the assistant messages that the server will delete
      const toDrop = rows.slice(lastUserIndex + 1).map((r) => r.id);
      if (toDrop.length > 0) {
        setDroppedIds((prev) => new Set([...prev, ...toDrop]));
      }

      // Keep only messages up to and including the last user message
      // This removes any assistant replies that will be regenerated
      const rowsToKeep = rows.slice(0, lastUserIndex + 1);

      const seeded: UIMessage[] = rowsToKeep.map((row) => ({
        id: row.id,
        role: row.role,
        parts: [{ type: 'text', text: row.content }],
      }));
      chat.setMessages(seeded);

      // Clear reasoning cache for regenerated messages
      for (const row of rows.slice(lastUserIndex + 1)) {
        reasoningCache.current.delete(row.id);
      }
    }

    try {
      void chat.regenerate();
    } catch {
      // No settled rows: nothing to retry.
    }
  };

  /** Saves a prompt edit; the stale reply is dropped, then the exchange regenerates. */
  const editMessage = async (messageId: string, content: string): Promise<boolean> => {
    const trimmed = content.trim();
    if (!trimmed || chat.status === 'submitted' || chat.status === 'streaming') return false;
    try {
      await updateMessage(threadId, messageId, trimmed);
      onSettle(); // drop the deleted reply + show the edited prompt right away
      retryLast({ messageId, content: trimmed });
      return true;
    } catch {
      return false;
    }
  };

  return (
    <ChatView
      rows={display}
      status={chat.status}
      errorMessage={chat.error?.message ?? null}
      onSend={send}
      onStop={() => chat.stop()}
      onRetryLast={() => retryLast()}
      onEditMessage={editMessage}
    />
  );
}

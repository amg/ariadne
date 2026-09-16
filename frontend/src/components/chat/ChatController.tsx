import type { Message } from '@/services/api';
import { updateMessage } from '@/services/api';
import { useChat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import { DefaultChatTransport } from 'ai';
import { useMemo, useRef, useState } from 'react';
import ChatView, { type DisplayRow } from './ChatView';

/**
 * Owns the live AI exchange for one thread: `useChat` transport, optimistic
 * + streaming rows merged over the settled loader rows, and send/stop.
 * Renders the pure ChatView. (The page only wires router glue.)
 */

type ChatControllerProps = {
  threadId: string;
  /** Settled rows from the messages loader (source of truth when idle). */
  rows: Message[];
  /** Called once per finished or failed stream so the page revalidates. */
  onSettle: () => void;
  isNewChat?: boolean;
  onGenerateTitle?: () => void;
};

type UiMessageLike = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: Array<{ type: string; text?: string }>;
};

/** Join the text parts of a useChat message into one content string. */
function joinTextParts(parts: UiMessageLike['parts']): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

/** Extract reasoning parts from a useChat message. */
function extractReasoning(parts: UiMessageLike['parts']): string {
  return parts
    .filter((part) => part.type === 'reasoning')
    .map((part) => part.text ?? '')
    .join('');
}

/** Counts rows per (role, content) — the dedup key against chat state. */
function countByKey(rows: Message[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.role}:${row.content}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Merge rules (ids differ between optimistic/streaming state and DB rows):
 * - rows already in the DB render from loader data — ids pinned by the server,
 *   and any live message id matching a DB row maps onto that settled row.
 * - chat messages not covered by a DB row render as pending (optimistic user
 *   bubble, in-flight assistant stream), appended in chat order.
 */
function buildSettledRow(
  row: Message,
  sdkMsg: UiMessageLike | undefined,
  streaming: boolean,
  reasoningCache: Map<string, string>,
): DisplayRow {
  const needsOverlay = sdkMsg && sdkMsg.role === 'assistant' && (streaming || row.content === '');
  if (needsOverlay) {
    const content = joinTextParts(sdkMsg.parts);
    const reasoning = extractReasoning(sdkMsg.parts);
    return {
      id: row.id,
      message: { ...row, content },
      usage: row.usage ?? null,
      streaming: streaming, // True while actually streaming, false during the revalidation gap
      reasoning: reasoning || null,
    };
  }
  return {
    id: row.id,
    message: row,
    usage: row.usage ?? null,
    streaming: false,
    reasoning: reasoningCache.get(row.id) ?? null,
  };
}

function mergeDisplayRows(
  rows: Message[],
  chatMessages: UiMessageLike[],
  streaming: boolean,
  reasoningCache: Map<string, string>,
): DisplayRow[] {
  const sdkMessages = new Map(chatMessages.map((m) => [m.id, m]));
  const usageById = new Map(rows.map((row) => [row.id, row.usage ?? null]));

  const settled = rows.map((row) =>
    buildSettledRow(row, sdkMessages.get(row.id), streaming, reasoningCache),
  );

  const rowCountByKey = countByKey(rows);
  const shownByKey = new Map<string, number>();
  const pending: DisplayRow[] = [];

  for (const message of chatMessages) {
    const content = joinTextParts(message.parts);
    const reasoning = message.role === 'assistant' ? extractReasoning(message.parts) : null;

    // Track how many times this exact role+content has been shown
    const key = `${message.role}:${content}`;
    const shown = (shownByKey.get(key) ?? 0) + 1;
    shownByKey.set(key, shown);

    // Skip if matched by ID (already overlaid in settled) or by role+content count (user optimistic)
    const alreadySettled = usageById.has(message.id) || shown <= (rowCountByKey.get(key) ?? 0);
    if (alreadySettled) continue;

    // Only add to pending if there's content OR reasoning (for thinking-only phase)
    const hasContent = content.length > 0 || (reasoning && reasoning.length > 0);
    if (!hasContent) continue;

    pending.push({
      id: message.id,
      message: {
        id: message.id,
        role: message.role,
        content,
        createdAt: new Date().toISOString(),
        usage: null,
      },
      usage: null,
      streaming: message.role === 'assistant' && streaming,
      reasoning: reasoning || null,
    });
  }

  return [...settled, ...pending];
}

function findTargetUserMessageIndex(rows: Message[], overrideId?: string): number {
  if (overrideId) {
    return rows.findIndex((row) => row.id === overrideId);
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'user') return i;
  }
  return -1;
}

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

  // Keep track of the latest isNewChat value without re-triggering useChat options
  const isNewChatRef = useRef(isNewChat);
  useMemo(() => {
    isNewChatRef.current = isNewChat;
  }, [isNewChat]);

  const chat = useChat({
    id: threadId,
    transport,
    // After every stream (including user stop) refetch rows so usage
    // metadata and persisted ids replace the optimistic/streaming state.
    onFinish: () => {
      onSettle();
      if (onGenerateTitle) {
        onGenerateTitle();
      }
    },
    onError: () => {
      onSettle();
      if (onGenerateTitle) {
        onGenerateTitle();
      }
    },
  });

  // Preserve reasoning across renders (even after stream completes)
  const reasoningCache = useRef<Map<string, string>>(new Map());

  // Update cache with any new reasoning from chat messages
  useMemo(() => {
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

  const display = useMemo(
    () =>
      mergeDisplayRows(visibleRows, chat.messages, chat.status !== 'ready', reasoningCache.current),
    [visibleRows, chat.messages, chat.status],
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

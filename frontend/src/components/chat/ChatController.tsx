import type { Message } from '@/services/api';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useMemo } from 'react';
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
function mergeDisplayRows(
  rows: Message[],
  chatMessages: UiMessageLike[],
  streaming: boolean,
): DisplayRow[] {
  const usageById = new Map(rows.map((row) => [row.id, row.usage ?? null]));
  const settled: DisplayRow[] = rows.map((row) => ({
    id: row.id,
    message: row,
    usage: row.usage ?? null,
    streaming: false,
  }));

  const rowCountByKey = countByKey(rows);
  const shownByKey = new Map<string, number>();
  const pending: DisplayRow[] = [];

  for (const message of chatMessages) {
    const content = joinTextParts(message.parts);
    const key = `${message.role}:${content}`;
    const shown = (shownByKey.get(key) ?? 0) + 1;
    shownByKey.set(key, shown);

    const alreadySettled = usageById.has(message.id) || shown <= (rowCountByKey.get(key) ?? 0);
    if (alreadySettled) continue;

    pending.push({
      id: message.id,
      message: {
        id: message.id,
        role: message.role,
        content,
        created_at: new Date().toISOString(),
        usage: null,
      },
      usage: null,
      streaming: message.role === 'assistant' && streaming,
    });
  }

  return [...settled, ...pending];
}

export default function ChatController({ threadId, rows, onSettle }: ChatControllerProps) {
  // One transport per thread; the Outlet is keyed by threadId (AppLayout),
  // so useChat state is rebuilt on navigation and never leaks across threads.
  const transport = useMemo(
    () => new DefaultChatTransport({ api: `/api/threads/${threadId}/chat` }),
    [threadId],
  );

  const chat = useChat({
    id: threadId,
    transport,
    // After every stream (including user stop) refetch rows so usage
    // metadata and persisted ids replace the optimistic/streaming state.
    onFinish: () => onSettle(),
    onError: () => onSettle(),
  });

  const display = useMemo(
    () => mergeDisplayRows(rows, chat.messages, chat.status !== 'ready'),
    [rows, chat.messages, chat.status],
  );

  const send = (content: string) => {
    if (!content.trim() || chat.status === 'submitted' || chat.status === 'streaming') return;
    chat.sendMessage({ role: 'user', parts: [{ type: 'text', text: content.trim() }] });
  };

  return (
    <ChatView
      rows={display}
      status={chat.status}
      errorMessage={chat.error?.message ?? null}
      onSend={send}
      onStop={() => chat.stop()}
    />
  );
}

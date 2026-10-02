import type { Message, MessageDriftVerdict } from '@/services/api';
import type { UIMessage } from 'ai';
import type { DisplayRow } from '../ChatView';
import type { StreamVerdict, UiMessageLike } from './types';

/** Join the text parts of a useChat message into one content string. */
export function joinTextParts(parts: UiMessageLike['parts']): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

/** Extract reasoning parts from a useChat message. */
export function extractReasoning(parts: UiMessageLike['parts']): string {
  return parts
    .filter((part) => part.type === 'reasoning')
    .map((part) => part.text ?? '')
    .join('');
}

/** Counts rows per (role, content) — the dedup key against chat state. */
export function countByKey(rows: Message[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.role}:${row.content}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The live gate's verdict rides the stream as a TRANSIENT
 * `data-thread-verdict` part, written before any reply content. Transient
 * data parts never land in `message.parts` — the SDK delivers them only
 * through useChat's `onData` — so this payload is parsed there. Returns
 * null on any part that is not a verdict payload.
 */
export function readVerdictData(part: { data?: unknown }): StreamVerdict | null {
  if (part.data === undefined || typeof part.data !== 'object') return null;
  const data = part.data as { verdict?: string; fireChannel?: string | null };
  if (data.verdict !== 'muted' && data.verdict !== 'pass' && data.verdict !== 'fire') return null;
  return {
    userMessageId: '',
    verdict: data.verdict,
    fireChannel:
      data.fireChannel === 'immediate' || data.fireChannel === 'slow' ? data.fireChannel : null,
  };
}

/** The most recent user message in live chat state — the pending arrival. */
export function lastUserMessage(chatMessages: UiMessageLike[]): UiMessageLike | null {
  for (let i = chatMessages.length - 1; i >= 0; i -= 1) {
    const candidate = chatMessages[i];
    if (candidate?.role === 'user') return candidate;
  }
  return null;
}

/** Maps a DB row (or a just-forked prompt) into an SDK message for seeding. */
export function toUiMessage(source: {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}): UIMessage {
  return {
    id: source.id,
    role: source.role,
    parts: [{ type: 'text', text: source.content }],
  };
}

/**
 * Builds the SDK seed for a retry. The server is authoritative on the
 * exchange; the seed exists only to satisfy the SDK's last-message guard,
 * and carries every row up to the target (abandoned included). The override
 * carries an edit fork the revalidator hasn't applied to `rows` yet.
 */
export function buildRetrySeed(
  rows: Message[],
  override?: { messageId: string; content: string },
): { seeded: UIMessage[]; toDrop: string[]; clearIds: string[] } | null {
  const targetIndex = findTargetUserMessageIndex(rows, override?.messageId);

  if (targetIndex >= 0) {
    const prefix = rows.slice(0, targetIndex).filter((row) => !row.abandoned);
    const target = rows[targetIndex];
    if (!target) return null;
    const after = rows.slice(targetIndex + 1);
    return {
      seeded: [...prefix.map(toUiMessage), toUiMessage(target)],
      // Stale answers past the target are hidden optimistically; the server
      // abandons them in the DB rather than deleting.
      toDrop: after.filter((row) => !row.abandoned).map((row) => row.id),
      clearIds: after.map((row) => row.id),
    };
  }
  if (!override) return null;

  // The edit fork hasn't reached `rows` yet: it replaces the newest user
  // turn (which the server has already abandoned server-side, but `rows`
  // doesn't know yet), so seed the live prefix and drop that whole turn —
  // arrival and replies alike — instead of re-seeding it.
  const replacedIndex = findTargetUserMessageIndex(rows);
  const prefix = (replacedIndex >= 0 ? rows.slice(0, replacedIndex) : rows).filter(
    (row) => !row.abandoned,
  );
  const replaced = replacedIndex >= 0 ? rows.slice(replacedIndex) : [];
  return {
    seeded: [
      ...prefix.map(toUiMessage),
      toUiMessage({ id: override.messageId, role: 'user', content: override.content }),
    ],
    toDrop: replaced.filter((row) => !row.abandoned).map((row) => row.id),
    clearIds: replaced.map((row) => row.id),
  };
}

/**
 * Merge rules (ids differ between optimistic/streaming state and DB rows):
 * - rows already in the DB render from loader data — ids pinned by the server,
 *   and any live message id matching a DB row maps onto that settled row.
 * - chat messages not covered by a DB row render as pending (optimistic user
 *   bubble, in-flight assistant stream), appended in chat order.
 */
export function buildSettledRow(
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
      streaming: streaming,
      reasoning: reasoning || null,
      verdict: row.driftVerdict ?? null,
    };
  }
  return {
    id: row.id,
    message: row,
    usage: row.usage ?? null,
    streaming: false,
    reasoning: reasoningCache.get(row.id) ?? null,
    verdict: row.driftVerdict ?? null,
  };
}

/** The live verdict a pending row wears — only its own arrival bubble. */
export function pendingVerdictFor(
  message: UiMessageLike,
  liveVerdict: StreamVerdict | null,
): MessageDriftVerdict | null {
  if (!liveVerdict || message.role !== 'user' || liveVerdict.userMessageId !== message.id) {
    return null;
  }
  return { verdict: liveVerdict.verdict, fireChannel: liveVerdict.fireChannel };
}

/**
 * While an exchange runs, a trailing assistant DB row is its unsettled
 * counterpart: content persists only at settlement, so the row arrives
 * empty wherever the loader refetches mid-stream. The live chat state is
 * the latest state of that exchange — the empty row hides until the stream
 * speaks for itself.
 */
function hideUnsettledExchangeRow(
  rows: Message[],
  status: 'submitted' | 'streaming' | 'ready' | 'error',
): Message[] {
  if (status === 'ready' || status === 'error') return rows;
  return rows.filter(
    (row, index) => !(index === rows.length - 1 && row.role === 'assistant' && row.content === ''),
  );
}

export function mergeDisplayRows(
  rows: Message[],
  chatMessages: UiMessageLike[],
  status: 'submitted' | 'streaming' | 'ready' | 'error',
  reasoningCache: Map<string, string>,
  liveVerdict: StreamVerdict | null,
): DisplayRow[] {
  const settledRows = hideUnsettledExchangeRow(rows, status);

  const sdkMessages = new Map(chatMessages.map((m) => [m.id, m]));
  const usageById = new Map(settledRows.map((row) => [row.id, row.usage ?? null]));

  const isStreamingAssistant =
    status === 'streaming' && chatMessages[chatMessages.length - 1]?.role === 'assistant';
  const lastStreamingAssistantId = isStreamingAssistant
    ? chatMessages[chatMessages.length - 1]?.id
    : null;

  const settled = settledRows.map((row) =>
    buildSettledRow(
      row,
      sdkMessages.get(row.id),
      row.id === lastStreamingAssistantId,
      reasoningCache,
    ),
  );

  const rowCountByKey = countByKey(settledRows);
  const shownByKey = new Map<string, number>();
  const pending: DisplayRow[] = [];

  for (const message of chatMessages) {
    const content = joinTextParts(message.parts);
    const reasoning = message.role === 'assistant' ? extractReasoning(message.parts) : null;

    const key = `${message.role}:${content}`;
    const shown = (shownByKey.get(key) ?? 0) + 1;
    shownByKey.set(key, shown);

    const alreadySettled = usageById.has(message.id) || shown <= (rowCountByKey.get(key) ?? 0);
    if (alreadySettled) continue;

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
      streaming: message.id === lastStreamingAssistantId,
      reasoning: reasoning || null,
      verdict: pendingVerdictFor(message, liveVerdict),
    });
  }

  return [...settled, ...pending];
}

export function findTargetUserMessageIndex(rows: Message[], overrideId?: string): number {
  if (overrideId) {
    return rows.findIndex((row) => row.id === overrideId);
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'user') return i;
  }
  return -1;
}

import { Chat } from '@ai-sdk/react';
import { chat as chatEndpoint } from '@ari/lib/api/schemas/chat/chat';
import { pathOf } from '@ari/lib/api/schemas/common/endpoint';
import { DefaultChatTransport, type UIMessage } from 'ai';

/**
 * Per-tab registry of thread chat objects. The objects live outside the
 * React lifecycle, so leaving a thread page unmounts only the view — the
 * running exchange streams on, and returning reattaches to it. The object
 * (and the tab's whole registry) dies only with the tab, which is the one
 * shutdown a user means.
 *
 * Settlement side effects live here for the same reason: an exchange can
 * finish while no view of its thread is mounted, so the registry fans
 * its callbacks out to whichever view is subscribed.
 */

/** A view mounted on one thread receives these exchange notifications. */
type ThreadChatListener = {
  /** A transient data part from the stream (the live verdict signal). */
  onData?: (part: { type?: string; data?: unknown }) => void;
  /** The exchange settled — finished, aborted, or failed. */
  onSettle?: () => void;
  /** A submit failed before or during its exchange; the draft text never landed. */
  onFailedSubmit?: (draft: string) => void;
};

/**
 * The outcomes a chat request settles to while the Drift gate is still
 * reaching its verdict: `gate_pending` while the judgment runs, or
 * `gate_failed` once it has given up. In neither did the submit fail —
 * the arrival is stored, so the optimistic message and its wait stay on
 * screen and a retry re-waits on the same judgment.
 */
export type GateWaitOutcome = 'gate_pending' | 'gate_failed';

/**
 * The response body a failed chat request delivered. The transport
 * throws with the raw body text, which the server always sends as JSON
 * with a stable `errorCode`; null when the failure carried no such
 * body (a network fault).
 */
function chatErrorBody(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  try {
    const parsed = JSON.parse(message) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as { error?: unknown; errorCode?: unknown })
      : null;
  } catch {
    return null;
  }
}

/** The gate-wait class of a failed chat request; null for any other failure. */
export function gateWaitOutcomeOf(error: unknown) {
  const { errorCode } = chatErrorBody(error) ?? {};
  if (errorCode === 'gate_pending' || errorCode === 'gate_failed') return errorCode;
  return null;
}

/**
 * Friendly text for a failed chat request: the server's curated message
 * when the body carries one, else whatever the failure said. Null when
 * there was no failure, or when it was a gate wait, which is not an
 * error and has its own notice.
 */
export function describeChatError(error: unknown) {
  if (!error || gateWaitOutcomeOf(error)) return null;
  const body = chatErrorBody(error);
  if (body && typeof body.error === 'string' && body.error.length > 0) return body.error;
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error.length > 0 ? error : null;
}

const chats = new Map<string, Chat<UIMessage>>();
const listeners = new Map<string, Set<ThreadChatListener>>();
/** Draft text of the thread's in-flight submit, when one is running. */
const pendingSubmits = new Map<string, string>();

function notify(threadId: string, call: (listener: ThreadChatListener) => void) {
  listeners.get(threadId)?.forEach(call);
}

/** The joined text of a message's text parts. */
function textOf(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text?: string }).text ?? '')
    .join('');
}

/**
 * Drops a failed submit's optimistic user message from chat state and
 * returns its draft text; null when no submit was in flight. Regenerates
 * never add a message, so they leave chat state untouched here.
 */
function dropOptimisticSubmit(threadId: string) {
  const draft = pendingSubmits.get(threadId);
  if (draft === undefined) return null;
  pendingSubmits.delete(threadId);

  const chat = chats.get(threadId);
  if (!chat) return draft;
  const last = chat.messages[chat.messages.length - 1];
  if (last?.role === 'user' && textOf(last) === draft) {
    chat.messages = chat.messages.slice(0, -1);
  }
  return draft;
}

/** A failed submit hands its text back: the restored draft becomes its only copy. */
function rollBackFailedSubmit(threadId: string) {
  const draft = dropOptimisticSubmit(threadId);
  if (draft === null) return;
  notify(threadId, (listener) => listener.onFailedSubmit?.(draft));
}

/**
 * Whether the request failed after its arrival was stored, because another
 * request answers it or it was edited away during the wait. The Thread's
 * stored rows then show what became of it, so no draft comes back.
 */
function arrivalSettledElsewhere(error: unknown) {
  const { errorCode } = chatErrorBody(error) ?? {};
  return errorCode === 'arrival_answered' || errorCode === 'arrival_abandoned';
}

/**
 * A failure's handling, keyed by the kind of failure. A gate wait leaves
 * the optimistic message and its draft alone — the arrival is stored and
 * owed an answer, not rejected; the outcome stays readable on the chat's
 * error until the next request. An arrival settled elsewhere drops the
 * optimistic copy only. Any other failure rolls the submit back.
 */
function handleFailedRequest(threadId: string, error: unknown) {
  if (gateWaitOutcomeOf(error)) {
    pendingSubmits.delete(threadId);
    return;
  }
  if (arrivalSettledElsewhere(error)) {
    dropOptimisticSubmit(threadId);
    return;
  }
  rollBackFailedSubmit(threadId);
}

/** Returns the thread's chat object, creating it on first use in this tab. */
export function getThreadChat(threadId: string) {
  const existing = chats.get(threadId);
  if (existing) return existing;

  const chat = new Chat<UIMessage>({
    id: threadId,
    transport: new DefaultChatTransport({ api: pathOf(chatEndpoint, { id: threadId }) }),
    onData: (part) => notify(threadId, (listener) => listener.onData?.(part)),
    // Fires after every exchange end — finished, stopped, or failed.
    onFinish: () => {
      pendingSubmits.delete(threadId);
      notify(threadId, (listener) => listener.onSettle?.());
    },
    // Fires before onFinish on failures; the submit record still exists here.
    onError: (error) => handleFailedRequest(threadId, error),
  });
  chats.set(threadId, chat);
  return chat;
}

/** Subscribes the mounted view to its thread's exchange notifications. */
export function subscribeToThreadChat(threadId: string, listener: ThreadChatListener) {
  let set = listeners.get(threadId);
  if (!set) {
    set = new Set();
    listeners.set(threadId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/**
 * Asks for the reply to a user message the server already stored as the
 * thread's newest row (a handed-over arrival). Nothing is sent: a failed
 * request leaves the message in place, retryable like any failed reply.
 */
export function replyToStoredMessage(threadId: string, message: { id: string; content: string }) {
  const chat = getThreadChat(threadId);
  chat.messages = [
    { id: message.id, role: 'user', parts: [{ type: 'text', text: message.content }] },
  ];
  void chat.regenerate();
}

/** Sends a user message and records its draft for failed-submit recovery. */
export function sendThreadMessage(threadId: string, content: string) {
  pendingSubmits.set(threadId, content);
  getThreadChat(threadId).sendMessage({
    role: 'user',
    parts: [{ type: 'text', text: content }],
  });
}

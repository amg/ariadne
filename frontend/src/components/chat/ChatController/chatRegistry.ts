import { Chat } from '@ai-sdk/react';
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
export type ThreadChatListener = {
  /** A transient data part from the stream (the live verdict signal). */
  onData?: (part: { type?: string; data?: unknown }) => void;
  /** The exchange settled — finished, aborted, or failed. */
  onSettle?: () => void;
  /** A submit failed before or during its exchange; the draft text never landed. */
  onFailedSubmit?: (draft: string) => void;
};

const chats = new Map<string, Chat<UIMessage>>();
const listeners = new Map<string, Set<ThreadChatListener>>();
/** Draft text of the thread's in-flight submit, when one is running. */
const pendingSubmits = new Map<string, string>();

function notify(threadId: string, call: (listener: ThreadChatListener) => void): void {
  listeners.get(threadId)?.forEach(call);
}

/** The joined text of a message's text parts. */
function textOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text?: string }).text ?? '')
    .join('');
}

/**
 * On a failed submit the optimistic user message is still in chat state.
 * Removing it keeps the restored draft the only visible copy of the text.
 * Regenerates never add a message, so they leave chat state untouched here.
 */
function rollBackFailedSubmit(threadId: string): void {
  const draft = pendingSubmits.get(threadId);
  if (draft === undefined) return;
  pendingSubmits.delete(threadId);

  const chat = chats.get(threadId);
  if (!chat) return;
  const last = chat.messages[chat.messages.length - 1];
  if (last?.role === 'user' && textOf(last) === draft) {
    chat.messages = chat.messages.slice(0, -1);
  }

  notify(threadId, (listener) => listener.onFailedSubmit?.(draft));
}

/** Returns the thread's chat object, creating it on first use in this tab. */
export function getThreadChat(threadId: string): Chat<UIMessage> {
  const existing = chats.get(threadId);
  if (existing) return existing;

  const chat = new Chat<UIMessage>({
    id: threadId,
    transport: new DefaultChatTransport({ api: `/api/threads/${threadId}/chat` }),
    onData: (part) => notify(threadId, (listener) => listener.onData?.(part)),
    // Fires after every exchange end — finished, stopped, or failed.
    onFinish: () => {
      pendingSubmits.delete(threadId);
      notify(threadId, (listener) => listener.onSettle?.());
    },
    // Fires before onFinish on failures; the submit record still exists here.
    onError: () => rollBackFailedSubmit(threadId),
  });
  chats.set(threadId, chat);
  return chat;
}

/** Subscribes the mounted view to its thread's exchange notifications. */
export function subscribeToThreadChat(threadId: string, listener: ThreadChatListener): () => void {
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

/** Sends a user message and records its draft for failed-submit recovery. */
export function sendThreadMessage(threadId: string, content: string): void {
  pendingSubmits.set(threadId, content);
  getThreadChat(threadId).sendMessage({
    role: 'user',
    parts: [{ type: 'text', text: content }],
  });
}

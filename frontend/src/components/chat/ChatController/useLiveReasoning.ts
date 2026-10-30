import { useRef } from 'react';
import type { UiMessageLike } from './types';
import { extractReasoning } from './utils';

/**
 * Keeps the reasoning of the live chat messages, so it still shows once a
 * stream has completed, and a snapshot of the messages for `onData`, which
 * fires mid-stream outside any render. Both refs are written during the
 * render that receives the messages, never in an effect: the display merge
 * reads the cache in that same render, and an effect would show reasoning
 * one render late.
 */
export function useLiveReasoning(messages: UiMessageLike[]) {
  const reasoningCache = useRef<Map<string, string>>(new Map());
  const messagesRef = useRef<UiMessageLike[]>([]);

  if (messagesRef.current !== messages) {
    messagesRef.current = messages;
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const reasoning = extractReasoning(msg.parts);
        if (reasoning) reasoningCache.current.set(msg.id, reasoning);
      }
    }
  }

  return { messagesRef, reasoningCache };
}

import type { Message } from '@db/types';

/** A user arrival and its exchange context — the transformer's unit. */
export interface LiveTurnRow {
  /** 1-based index of this user message within the thread. */
  turnNumber: number;
  userMessage: Message;
  /** The completing assistant message; null while the turn is still open. */
  assistantReply: Message | null;
}

/** One row per user message in thread order, with its adjacent assistant reply. */
export function buildLiveTurns(messages: Message[]): LiveTurnRow[] {
  const turns: LiveTurnRow[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const next = messages[i + 1];
    turns.push({
      turnNumber: turns.length + 1,
      userMessage: message,
      assistantReply: next && next.role === 'assistant' ? next : null,
    });
  }
  return turns;
}

import type { Message } from '@db/types';

/**
 * The Turn text blocks that get embedded. A Turn embeds once as its text
 * block, keyed to the Turn's assistant Message.
 */

export interface Turn {
  /** 1-based Turn number. */
  turnNumber: number;
  userMessage: Message;
  assistantMessage: Message;
}

/**
 * The Prospective Turn text block: the Turn block with an
 * empty assistant half — the byte-legal empty-assistant passage of the
 * frozen format. `formattedTurn` shares this builder, so a complete Turn whose
 * assistant reply is empty embeds byte-identically to its Prospective.
 */
export function formattedProspectiveTurn(userContent: string) {
  return `User:\n${userContent}\n\n`;
}

/**
 * The Turn text block that gets embedded. An empty assistant content
 * contributes nothing to the text, but the Turn keeps its position.
 */
export function formattedTurn(turn: Turn) {
  const assistant = turn.assistantMessage.content;
  if (assistant.length === 0) return formattedProspectiveTurn(turn.userMessage.content);
  return `User:\n${turn.userMessage.content}\n\nAssistant:\n${assistant}\n\n`;
}

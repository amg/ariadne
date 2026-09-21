import type { Message } from '@db/types';

/**
 * Pure Turn reconstruction and embedding-target building (folder-private;
 * verified through `analyzeThread`). Key concepts: Turn, Turn
 * embedding. Binds the Turn is the unit of embedding and scoring
 * — each Turn embeds once as its text block, keyed to the Turn's assistant
 * Message.
 */

export interface Turn {
  /** 1-based Turn number. */
  turnNumber: number;
  userMessage: Message;
  assistantMessage: Message;
}

/**
 * Reconstruct `(user, assistant)` Turns from ordered message rows. Each
 * assistant message completes the Turn opened by the nearest preceding
 * unpaired user message; a trailing user message with no reply completes
 * no Turn and is ignored.
 */
export function pairTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let pendingUser: Message | undefined;
  for (const message of messages) {
    if (message.role === 'user') {
      pendingUser = message;
      continue;
    }
    if (message.role === 'assistant' && pendingUser) {
      turns.push({
        turnNumber: turns.length + 1,
        userMessage: pendingUser,
        assistantMessage: message,
      });
      pendingUser = undefined;
    }
  }
  return turns;
}

/**
 * The Prospective Turn text block: the Turn block with an
 * empty assistant half — the byte-legal empty-assistant passage of the
 * frozen format. `turnText` shares this builder, so a complete Turn whose
 * assistant reply is empty embeds byte-identically to its Prospective.
 */
export function prospectiveText(userContent: string): string {
  return `User:\n${userContent}\n\n`;
}

/**
 * The frozen Turn text block . Wave 3's live Drift gate must
 * produce byte-identical blocks from this format. An empty assistant
 * content contributes nothing to the text, but the Turn keeps its
 * position.
 */
function turnText(turn: Turn): string {
  const assistant = turn.assistantMessage.content;
  if (assistant.length === 0) return prospectiveText(turn.userMessage.content);
  return `User:\n${turn.userMessage.content}\n\nAssistant:\n${assistant}\n\n`;
}

export interface TurnBlock {
  /** 1-based Turn number. */
  turnNumber: number;
  /** The Turn's assistant Message — the key the embedding is stored under. */
  assistantMessage: Message;
  /** The frozen text block that embeds as the unit. */
  text: string;
}

/**
 * One embedding target per Turn. With the unit collapsed to the Turn
 * this is the entire scored set: every complete Turn embeds
 * exactly once, keyed to the Turn's assistant Message — "state of the
 * conversation ending at this Turn".
 */
export function buildTurnBlocks(turns: Turn[]): TurnBlock[] {
  return turns.map((turn) => ({
    turnNumber: turn.turnNumber,
    assistantMessage: turn.assistantMessage,
    text: turnText(turn),
  }));
}

/** A Prospective Turn's incoming user Message — its Turn ordinal. */
export interface ProspectiveBlock {
  /** 1-based Turn number. */
  turnNumber: number;
  /** The incoming user Message (the report axis it sits on). */
  userMessage: Message;
  /** The empty-assistant Turn block that embeds transiently. */
  text: string;
}

/**
 * One Prospective Turn per complete Turn — what the live gate would have
 * scored when the user Message arrived. Transient by
 * construction: nothing here keys to storage (Prospective blocks have no
 * assistant Message to key to).
 */
export function buildProspectiveBlocks(turns: Turn[]): ProspectiveBlock[] {
  return turns.map((turn) => ({
    turnNumber: turn.turnNumber,
    userMessage: turn.userMessage,
    text: prospectiveText(turn.userMessage.content),
  }));
}

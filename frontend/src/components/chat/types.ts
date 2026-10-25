import type { Message, MessageDriftVerdict, MessageUsage } from '@/services/api';

export interface DisplayRow {
  id: string;
  message: ShownMessage;
  usage: MessageUsage | null;
  /** True while this assistant row is still being streamed. */
  streaming: boolean;
  /** Reasoning content (thinking) if available */
  reasoning?: string | null;
  /** Live-gate verdict on user arrivals — the advisory bubble signal. */
  verdict?: MessageDriftVerdict | null;
}

/** What a row shows of its message. A reply still streaming has none of the stored fields yet. */
type ShownMessage = Pick<Message, 'id' | 'role' | 'content' | 'createdAt'> &
  Partial<Pick<Message, 'gateFailed'>>;

/**
 * A failed submit's draft, returned for the input. The nonce rises with
 * every restore so an identical text repeated still re-fills.
 */
export interface RestoredDraft {
  text: string;
  nonce: number;
}

/**
 * Where moving a paused arrival into a fresh chat stands: not under way,
 * moving, or first saving what the old chat taught the Memory.
 */
export type HandoverProgress = 'idle' | 'moving' | 'saving-memory';

import type { Message, MessageDriftVerdict, MessageUsage } from '@/services/api';

/** A single bubble line plus its metadata row (settled or streaming). */
export interface DisplayRow {
  id: string;
  message: Message;
  usage: MessageUsage | null;
  /** True while this assistant row is still being streamed. */
  streaming: boolean;
  /** Reasoning content (thinking) if available */
  reasoning?: string | null;
  /** Live-gate verdict on user arrivals — the advisory bubble signal. */
  verdict?: MessageDriftVerdict | null;
}

export type ChatViewStatus = 'submitted' | 'streaming' | 'ready' | 'error';

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

import type { DriftFireChannel, DriftVerdict } from '@/services/api';

export type UiMessageLike = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: Array<{ type: string; text?: string; data?: unknown }>;
};

export type StreamVerdict = {
  /** The arrival in live chat state (an optimistic id while unsaved). */
  userMessageId: string;
  /** The arrival's stored id, as the server reported it. */
  messageId: string | null;
  verdict: DriftVerdict;
  fireChannel: DriftFireChannel | null;
};

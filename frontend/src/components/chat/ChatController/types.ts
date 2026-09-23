export type UiMessageLike = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: Array<{ type: string; text?: string; data?: unknown }>;
};

export type StreamVerdict = {
  userMessageId: string;
  verdict: 'muted' | 'pass' | 'fire';
  fireChannel: 'immediate' | 'slow' | null;
};

import { z } from 'zod';
import { driftVerdictSchema } from '../common/driftGate.ts';
import { id } from '../common/id.ts';
import { instant } from '../common/instant.ts';
import type { Wire } from '../common/wire.ts';

export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** How an assistant reply's exchange ended; `pending` while it streams. */
export const EXCHANGE_STATUSES = ['pending', 'completed', 'interrupted', 'error'] as const;
export type ExchangeStatus = (typeof EXCHANGE_STATUSES)[number];

/**
 * Why a reply stopped. `interrupted` is a user stop, `timeout` the
 * guard between tokens, and `error` a failed exchange.
 */
export const FINISH_REASONS = [
  'stop',
  'length',
  'content_filter',
  'tool_calls',
  'interrupted',
  'timeout',
  'error',
] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

/** What one assistant reply cost, as the provider reported it or as counted locally. */
export const messageUsageSchema = z.object({
  model: z.string(),
  /** Null when no provider response exists, as with estimated spend. */
  providerId: z.string().nullable(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  /** True when tokens and cost were counted locally rather than reported by the provider. */
  estimated: z.boolean(),
  /** Reasoning tokens the provider reported. */
  reasoningTokens: z.number().nullable(),
  /** Reasoning tokens estimated from the reasoning text; null with no reasoning. */
  estimatedReasoningTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  /** USD as decimal text. */
  costUsd: z.string(),
  finishReason: z.enum(FINISH_REASONS),
  latencyMs: z.number().nullable(),
});
export type MessageUsage = Wire<typeof messageUsageSchema>;

export const messageSchema = z.object({
  id,
  threadId: id,
  role: z.enum(MESSAGE_ROLES),
  content: z.string(),
  createdAt: instant,
  exchangeStatus: z.enum(EXCHANGE_STATUSES),
  /** Rows of a forked-away or failed exchange: kept for usage, hidden from the chat. */
  abandoned: z.boolean(),
  /** Set on assistant replies once usage is known. */
  usage: messageUsageSchema.nullable(),
  /** The gate's verdict on a user arrival; null elsewhere and while the gate is off. */
  driftVerdict: driftVerdictSchema.nullable(),
  /** True on the Thread's unanswered arrival when the gate could not judge it and gave up. */
  gateFailed: z.boolean(),
});
export type Message = Wire<typeof messageSchema>;

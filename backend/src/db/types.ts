import type { Generated, Insertable, Selectable } from 'kysely';

/**
 * Code-side identifiers are camelCase; `CamelCasePlugin` (see `db.ts`)
 * maps them onto the snake_case schema at query time and maps result
 * rows back to camelCase. Table keys follow the same convention
 * (`messageUsage` → `message_usage`).
 */
export interface Database {
  users: UsersTable;
  threads: ThreadsTable;
  messages: MessagesTable;
  messageUsage: MessageUsageTable;
  modelConfigs: ModelConfigsTable;
}

export interface UsersTable {
  id: Generated<string>; // UUID
  createdAt: Generated<Date>;
}

export interface ThreadsTable {
  id: Generated<string>; // UUID
  userId: string;
  title: string;
  createdAt: Generated<Date>;
}

export interface MessagesTable {
  id: Generated<string>; // UUID
  threadId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: Generated<Date>;
}

export interface MessageUsageTable {
  messageId: string; // UUID FK -> messages.id (1:1, PK)
  model: string;
  providerId: string;
  promptTokens: number;
  completionTokens: number;
  /** NULL when the provider doesn't report cache telemetry. */
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: string; // numeric(14,10) — Kysely selects numeric as string
  finishReason: string;
  latencyMs: number | null;
  createdAt: Generated<Date>;
}

export interface ModelConfigsTable {
  modelId: string; // Primary key
  provider: string;
  contextWindow: number | null;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cachedRateMultiplier: number | null; // multiplier of input price (e.g., 0.5 = 50%)
  supportsCaching: boolean;
  lastUpdated: Generated<Date>;
}

export type User = Selectable<UsersTable>;

export type Thread = Selectable<ThreadsTable>;
export type NewThread = Insertable<ThreadsTable>;

export type Message = Selectable<MessagesTable>;
export type NewMessage = Insertable<MessagesTable>;

export type MessageUsage = Selectable<MessageUsageTable>;
export type NewMessageUsage = Insertable<MessageUsageTable>;

export type ModelConfig = Selectable<ModelConfigsTable>;
export type NewModelConfig = Insertable<ModelConfigsTable>;

/**
 * Synthetic + provider finish states persisted on `message_usage`
 * (see MVP.md "Schema"). `interrupted` = user stop; `timeout` = inter-token
 * idle guard.
 */
export const FINISH_REASONS = [
  'stop',
  'length',
  'content_filter',
  'tool_calls',
  'interrupted',
  'timeout',
] as const;
export type MessageFinishReason = (typeof FINISH_REASONS)[number];

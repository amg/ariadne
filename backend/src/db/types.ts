import type { Generated, Insertable, Selectable, Updateable } from 'kysely';

export interface Database {
  users: UsersTable;
  threads: ThreadsTable;
  messages: MessagesTable;
  message_usage: MessageUsageTable;
  model_configs: ModelConfigsTable;
}

export interface UsersTable {
  id: Generated<string>; // UUID
  created_at: Generated<Date>;
}

export interface ThreadsTable {
  id: Generated<string>; // UUID
  user_id: string;
  title: string;
  created_at: Generated<Date>;
}

export interface MessagesTable {
  id: Generated<string>; // UUID
  thread_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: Generated<Date>;
}

export interface MessageUsageTable {
  message_id: string; // UUID FK -> messages.id (1:1, PK)
  model: string;
  provider_id: string;
  prompt_tokens: number;
  completion_tokens: number;
  /** NULL when the provider doesn't report cache telemetry. */
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: string; // numeric(14,10) — Kysely selects numeric as string
  finish_reason: string;
  latency_ms: number | null;
  created_at: Generated<Date>;
}

export interface ModelConfigsTable {
  model_id: string; // Primary key
  provider: string;
  context_window: number | null;
  input_price_per_million: number | null;
  output_price_per_million: number | null;
  cached_rate_multiplier: number | null; // multiplier of input price (e.g., 0.5 = 50%)
  supports_caching: boolean;
  last_updated: Generated<Date>;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;

export type Thread = Selectable<ThreadsTable>;
export type NewThread = Insertable<ThreadsTable>;

export type Message = Selectable<MessagesTable>;
export type NewMessage = Insertable<MessagesTable>;

export type MessageUsage = Selectable<MessageUsageTable>;
export type NewMessageUsage = Insertable<MessageUsageTable>;

export type ModelConfig = Selectable<ModelConfigsTable>;
export type NewModelConfig = Insertable<ModelConfigsTable>;
export type UpdateModelConfig = Updateable<ModelConfigsTable>;

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

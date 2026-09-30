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
  messageEmbeddings: MessageEmbeddingsTable;
  threadSegments: ThreadSegmentsTable;
  segmentDriftLogs: SegmentDriftLogsTable;
  modelConfigs: ModelConfigsTable;
}

export interface UsersTable {
  id: Generated<string>; // UUID
  createdAt: Generated<Date>;
}

export interface ThreadsTable {
  id: Generated<string>; // UUID
  userId: string;
  title: string | null;
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
  /** Provider-reported reasoning tokens (DeepInfra reports 0 even when reasoning). */
  reasoningTokens: number | null;
  /** Our estimate from reasoning content length (NULL when no reasoning). */
  estimatedReasoningTokens: number | null;
  costUsd: string; // numeric(14,10) — Kysely selects numeric as string
  finishReason: string;
  latencyMs: number | null;
  createdAt: Generated<Date>;
}

/**
 * Thread-health embeddings, keyed 1:1 to a Message. One table, two kinds:
 * a *Turn* row keys to the Turn's assistant Message — "state of the
 * conversation ending at this message", NOT "this message"; an *arrival*
 * row keys to the Turn's user Message — the arriving signal judged before
 * inference. Provenance is `(modelId)` alone — mismatched
 * rows are re-embedded, never compared.
 */
export interface MessageEmbeddingsTable {
  messageId: string; // UUID FK -> messages.id (1:1, PK, cascade delete)
  /**
   * pgvector `vector(1024)`; Postgres text form `[0.1,-0.2,…]` (parsed in
   * the query layer). Null only on arrival rows between the rewrite
   * step's outcome write and the embed step's vector fill — consumers
   * that need the vector must find it present.
   */
  embedding: string | null;
  modelId: string;
  /** Arrival rows only: the self-contained rewrite the embedding came from; null when none landed. */
  expandedText: string | null;
  /**
   * Arrival rows only: the recorded end of this arrival's try at a
   * rewrite; null when no rewrite was attempted (the raw message stood on
   * its own).
   */
  expandOutcome: ExpandOutcome | null;
  /** Per-step spend recorded for audit — never written to `message_usage`. numeric(14,10) → string. */
  embeddingCostUsd: string | null;
  rewriteCostUsd: string | null;
  judgeCostUsd: string | null;
  createdAt: Generated<Date>;
}

/**
 * The recorded end of one arrival's try at a rewrite: what the reading
 * ended up as, and when no reading landed, why — the rewrite model
 * refused, a quality check rejected it, the provider call failed, or the
 * output was unusable.
 */
export type ExpandOutcome =
  | 'accepted'
  | 'failed_refused'
  | 'failed_quality'
  | 'failed_inference'
  | 'failed';

/**
 * The live arrival chain the gate builds as the conversation progresses —
 * deliberately NOT the offline fold's segments. A segment's end is simply
 * the next segment's start (chronology), so there is no end column.
 */
export interface ThreadSegmentsTable {
  id: Generated<string>; // UUID
  threadId: string; // UUID FK -> threads.id (cascade delete)
  startMessageId: string; // UUID FK -> messages.id (first user Message of the segment)
  /** Provenance of the reading that cut this segment — the embedding model. */
  modelId: string;
  createdAt: Generated<Date>;
}

/**
 * One row per judged arrival in the live lane: the composite reading
 * judged against the segment it entered, plus the µ/σ/z snapshot of that
 * segment's baseline exactly as it stood BEFORE the arrival joined it. Muted
 * strides keep a row with null numbers.
 */
export interface SegmentDriftLogsTable {
  id: Generated<string>; // UUID
  segmentId: string; // UUID FK -> thread_segments.id (segment the arrival was judged in)
  messageId: string; // UUID FK -> messages.id (the user Message that arrived)
  /** Provenance of the judged reading — the embedding model. */
  modelId: string;
  /** The composite reading judged; null on muted arrivals. */
  driftP: number | null;
  mu: number | null;
  sigma: number | null;
  zScore: number | null;
  verdict: 'muted' | 'pass' | 'fire';
  /** Which channel produced a fire; null otherwise. */
  fireChannel: 'immediate' | 'slow' | null;
  /** When fireChannel === 'slow', the message ID of the turn that anchored the Page-Hinkley low-water mark. */
  slowDriftStartMessageId: string | null;
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

export type MessageEmbeddingStored = Selectable<MessageEmbeddingsTable>;

/** Turn embedding row as returned by `queries/messageEmbeddings` (vector parsed to numbers). */
export type MessageEmbedding = Omit<
  MessageEmbeddingStored,
  'embedding' | 'expandedText' | 'expandOutcome'
> & {
  rewrittenText: string | null;
  expandOutcome: ExpandOutcome | null;
} & {
  /** Null on arrival rows written by the rewrite step before the embed step filled the vector. */
  embedding: number[] | null;
};

/** Insert/upsert input for `queries/messageEmbeddings` (vector as numbers). */
export type NewMessageEmbedding = {
  messageId: string;
  embedding: number[];
  modelId: string;
};

/** Insert/upsert input for an *arrival* embedding row (keyed to the user Message). */
export type NewArrivalEmbedding = {
  messageId: string;
  embedding: number[];
  modelId: string;
  /** The self-contained rewrite the embedding came from; null when the raw message was embedded. */
  rewrittenText?: string | null;
  /** The recorded end of the arrival's try at a rewrite; pass through unchanged on re-writes. */
  expandOutcome?: ExpandOutcome | null;
  embeddingCostUsd?: number | null;
  rewriteCostUsd?: number | null;
  judgeCostUsd?: number | null;
};

export type ThreadSegment = Selectable<ThreadSegmentsTable>;
export type NewThreadSegment = Insertable<ThreadSegmentsTable>;

export type SegmentDriftLog = Selectable<SegmentDriftLogsTable>;
export type NewSegmentDriftLog = Insertable<SegmentDriftLogsTable>;

/**
 * Synthetic + provider finish states persisted on `message_usage`
 *. `interrupted` = user stop; `timeout` = inter-token
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

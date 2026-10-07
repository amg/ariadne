import type { Generated, Insertable, Kysely, Selectable } from 'kysely';

/**
 * Code-side identifiers are camelCase; `CamelCasePlugin` (see `db.ts`)
 * maps them onto the snake_case schema at query time and maps result
 * rows back to camelCase. Table keys follow the same convention
 * (`billing.messageUsage` → `billing.message_usage`). Every key carries
 * its domain schema: app tables live one domain per schema, the auth
 * provider's tables stay in `public`, and the queue engine owns its own
 * schema.
 */
export interface Database {
  'chat.users': UsersTable;
  'chat.threads': ThreadsTable;
  'chat.messages': MessagesTable;
  'analysis.messageEmbeddings': MessageEmbeddingsTable;
  'analysis.threadSegments': ThreadSegmentsTable;
  'analysis.segmentDriftLogs': SegmentDriftLogsTable;
  'memory.userFacts': UserFactsTable;
  'memory.threadSeeds': ThreadSeedsTable;
  'memory.userSettings': UserSettingsTable;
  'memory.memoryCaptureProgress': MemoryCaptureProgressTable;
  'billing.messageUsage': MessageUsageTable;
  'billing.messageSideCosts': MessageSideCostsTable;
  'billing.modelConfigs': ModelConfigsTable;
  'queues.jobs': QueueJobsView;
}

/**
 * A handle queries run on: the app database, or a transaction opened on
 * it. Writes that must commit together take the same handle.
 */
export type DbExecutor = Kysely<Database>;

/**
 * The background work queue's read-only job view, owned and migrated by
 * the queue engine. A job is deleted once it succeeds, so every row is
 * waiting, running, or dead.
 */
export interface QueueJobsView {
  id: string;
  taskIdentifier: string;
  /** The key duplicates merge on; null once a newer job took it over. */
  key: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  lockedAt: Date | null;
  lockedBy: string | null;
  runAt: Date;
  createdAt: Date;
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
  /**
   * Set on an exchange's arrival row when the exchange ended without
   * completing, so the abandoned arrival registers in the thread
   * (partial title + resume draft) instead of being swallowed.
   */
  abandoned: Generated<boolean>;
  /**
   * Lifecycle of an assistant row's exchange: `pending` while the reply
   * streams, terminal once it settles. Non-assistant rows keep the
   * terminal default.
   */
  exchangeStatus: Generated<MessageExchangeStatus>;
  createdAt: Generated<Date>;
}

/**
 * The recorded end of an assistant exchange. `pending` rows belong to a
 * live or lost stream; `interrupted` = stopped or disconnected on
 * purpose, `error` = the exchange failed.
 */
export const EXCHANGE_STATUSES = ['pending', 'completed', 'interrupted', 'error'] as const;
export type MessageExchangeStatus = (typeof EXCHANGE_STATUSES)[number];

/**
 * The chat exchange's inference telemetry, linked 1:1 to `messages`.
 * `estimated` flags rows the exchange counted locally because the
 * provider never reported usage (the exchange ended early); every other
 * column is filled on both paths. The analyzer pipeline's spend lives
 * elsewhere: embedding cost rides the arrival embedding row, and the
 * rewrite and judge steps carry their own rows in
 * `message_side_costs`.
 */
export interface MessageUsageTable {
  messageId: string; // UUID FK -> messages.id (PK)
  /** True when tokens and cost were counted locally, not provider-reported. */
  estimated: Generated<boolean>;
  model: string;
  /** NULL when no provider response exists (estimated spends). */
  providerId: string | null;
  /** Estimates count these locally, so the columns stay NOT NULL. */
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
  finishReason: MessageFinishReason;
  latencyMs: number | null;
  createdAt: Generated<Date>;
}

/**
 * Billed spend of the side pipelines, one row per (message, kind): the
 * arrival's rewrite (expansion) step and its trigger judge, and the Fact
 * capture a Boundary arrival triggers — extraction, duplicate checks, and
 * Fact embeddings, each summed across the segment's calls. The arrival
 * embedding step's cost rides the arrival embedding row instead.
 * Model attribution is fixed by the environment's pipeline models; the
 * provider response id is not persisted for these calls.
 */
export const SIDE_COST_KINDS = [
  'rewrite',
  'judge',
  'fact_extraction',
  'fact_duplicate_check',
  'fact_embedding',
] as const;
export type SideCostKind = (typeof SIDE_COST_KINDS)[number];

export interface MessageSideCostsTable {
  messageId: string; // UUID FK -> messages.id (PK together with `kind`)
  kind: SideCostKind;
  model: string;
  /** NULL when the provider reported no token counts. */
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: string; // numeric(14,10) — Kysely selects numeric as string
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
  /** The arrival's embedding spend recorded for audit. numeric(14,10) → string. */
  embeddingCostUsd: string | null;
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
 * How far Fact capture has read a segment — Memory's own bookkeeping,
 * kept out of the segmentation table. One row per segment that capture
 * has taken in at least once.
 */
export interface MemoryCaptureProgressTable {
  segmentId: string; // UUID PK, FK -> thread_segments.id (cascade)
  /** `created_at` of the last Turn a capture pass read. */
  capturedThroughAt: Date;
  updatedAt: Generated<Date>;
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

/** The fixed category set every Fact is filed under. */
export const FACT_CATEGORIES = [
  'identity',
  'preference',
  'health',
  'relationships',
  'work',
  'location',
  'credentials',
  'other',
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

/**
 * The Memory store: one self-contained sentence about the user per row.
 * Rows are superseded by invalidation (`invalidAt`), never overwritten.
 * Facts outlive Threads, so the source message reference nulls out when
 * its Thread is deleted.
 */
export interface UserFactsTable {
  id: Generated<string>; // UUID
  userId: string; // UUID FK -> users.id (cascade delete)
  content: string;
  category: FactCategory;
  /** Entity the Fact is about; "user" for the user themself. */
  subject: string | null;
  /** Normalized snake_case relation, e.g. `lives_in`. */
  predicate: string | null;
  object: string | null;
  /** pgvector `vector(1024)` in Postgres text form. */
  embedding: string;
  modelId: string;
  /** The user Message of the Turn the Fact came from; null once its Thread is gone. */
  sourceMessageId: string | null;
  /** When the Fact became true, as the conversation states it; null when it states none. */
  validAt: Date | null;
  /** When the Fact stopped being current; null while it is. */
  invalidAt: Date | null;
  /** Kept in the store but never injected into a Seed. */
  suppressed: Generated<boolean>;
  /** When the Fact was noted: its capture, or the edit that replaced an older row. */
  createdAt: Generated<Date>;
}

/**
 * A Thread's Seed: the memory block frozen at Thread creation and
 * prepended to the system prompt on every Exchange of that Thread.
 */
/**
 * One Fact as a Seed renders it, with its category kept so a category the
 * user blocks later drops out of Seeds already frozen.
 */
export interface SeedLine {
  category: FactCategory;
  text: string;
}

export interface ThreadSeedsTable {
  threadId: string; // UUID PK, FK -> threads.id (cascade delete)
  /** jsonb array, in render order. */
  lines: SeedLine[];
  factCount: number;
  /** The drift-paused arrival this Thread was handed over from; null otherwise. */
  handoverMessageId: string | null;
  validAt: Generated<Date>;
  invalidAt: Date | null;
  createdAt: Generated<Date>;
}

/** Per-user settings document; missing and unknown keys resolve in code. */
export interface UserSettingsTable {
  userId: string; // UUID PK, FK -> users.id (cascade delete)
  settings: unknown;
  updatedAt: Generated<Date>;
}

export type User = Selectable<UsersTable>;

export type Thread = Selectable<ThreadsTable>;
export type NewThread = Insertable<ThreadsTable>;

export type Message = Selectable<MessagesTable>;
export type NewMessage = Insertable<MessagesTable>;

export type MessageUsage = Selectable<MessageUsageTable>;
export type NewMessageUsage = Insertable<MessageUsageTable>;

export type MessageSideCost = Selectable<MessageSideCostsTable>;
export type NewMessageSideCost = Insertable<MessageSideCostsTable>;

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
  /** The arrival's embedding spend; the rewrite step never touches it. */
  embeddingCostUsd?: number | null;
};

export type ThreadSegment = Selectable<ThreadSegmentsTable>;
export type NewThreadSegment = Insertable<ThreadSegmentsTable>;

export type ThreadSeed = Selectable<ThreadSeedsTable>;

/** Fact row as returned by `queries/userFacts` (vector omitted). */
export type UserFact = Omit<Selectable<UserFactsTable>, 'embedding'>;

/** Insert input for `queries/userFacts` (vector as numbers). */
export type NewUserFact = {
  userId: string;
  content: string;
  category: FactCategory;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  embedding: number[];
  modelId: string;
  sourceMessageId: string | null;
  validAt: Date | null;
  /** Defaults to false. */
  suppressed?: boolean;
};

export type SegmentDriftLog = Selectable<SegmentDriftLogsTable>;
export type NewSegmentDriftLog = Insertable<SegmentDriftLogsTable>;

/**
 * Synthetic + provider finish states persisted on `message_usage`.
 * `interrupted` = user stop; `timeout` = inter-token idle guard;
 * `error` = the exchange failed (provider abort or stream error).
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
export type MessageFinishReason = (typeof FINISH_REASONS)[number];

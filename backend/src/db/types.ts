import type { Insertable, Kysely, Selectable } from 'kysely';
import type { DB } from './schema.generated';

export { FACT_CATEGORIES, type FactCategory } from '@ari/lib/api/schemas/settings/facts';
export type {
  ExchangeStatus as MessageExchangeStatus,
  FinishReason as MessageFinishReason,
} from '@ari/lib/api/schemas/messages/message';
export type { ExpandOutcome } from '@ari/lib/api/schemas/threads/analysis';

/**
 * The app's tables as the migrations build them, plus the two tables other
 * systems own. Code-side
 * identifiers are camelCase; `CamelCasePlugin` (see `db.ts`) maps them
 * onto the snake_case schema at query time and maps result rows back to
 * camelCase. Table keys follow the same convention
 * (`billing.messageUsage` → `billing.message_usage`). Every key carries
 * its domain schema: app tables live one domain per schema, the auth
 * provider's tables stay in `public`, and the queue engine owns its own
 * schema.
 */
export interface Database extends DB {
  'queues.jobs': QueueJobsView;
  'auth.emailpasswordUsers': EmailPasswordUsersTable;
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

/**
 * The auth provider's sign-in accounts. The provider owns and migrates this
 * table; the app only reads which user an email belongs to.
 */
interface EmailPasswordUsersTable {
  userId: string; // char(36), the same UUID as `chat.users.id`
  email: string;
}

export type NewThread = Insertable<Database['chat.threads']>;

export type Message = Selectable<Database['chat.messages']>;
export type NewMessage = Insertable<Database['chat.messages']>;

export type MessageUsage = Selectable<Database['billing.messageUsage']>;
export type NewMessageUsage = Insertable<Database['billing.messageUsage']>;

export type NewModelConfig = Insertable<Database['billing.modelConfigs']>;

export type MessageEmbeddingStored = Selectable<Database['analysis.messageEmbeddings']>;

/** Embedding row as returned by `queries/messageEmbeddings` (vector parsed to numbers). */
export type MessageEmbedding = Omit<MessageEmbeddingStored, 'embedding'> & { embedding: number[] };

/** Insert input for `queries/messageEmbeddings` (vector as numbers). */
export type NewMessageEmbedding = Omit<MessageEmbeddingStored, 'embedding' | 'createdAt'> & {
  embedding: number[];
};

/** Expansion row as returned by `queries/messageExpansions`. */
export type MessageExpansion = Selectable<Database['analysis.messageExpansions']>;

export type NewThreadSegment = Insertable<Database['analysis.threadSegments']>;

/** Insert input for `queries/userFacts` (vector as numbers). */
export type NewUserFact = Omit<
  Selectable<Database['memory.userFacts']>,
  'id' | 'embedding' | 'invalidAt' | 'suppressed' | 'createdAt'
> &
  Pick<Insertable<Database['memory.userFacts']>, 'suppressed'> & { embedding: number[] };

export type SegmentDriftLog = Selectable<Database['analysis.segmentDriftLogs']>;
export type NewSegmentDriftLog = Insertable<Database['analysis.segmentDriftLogs']>;
export type ArrivalJudgmentState = Selectable<Database['analysis.arrivalJudgmentStates']>;
export type NewArrivalJudgmentState = Insertable<Database['analysis.arrivalJudgmentStates']>;
export type TurnFold = Selectable<Database['analysis.turnFolds']>;
export type NewTurnFold = Insertable<Database['analysis.turnFolds']>;

/**
 * How a failed job's stored error tells its class: `recoverable` failures
 * are worth trying again on their own, `fatal` ones wait for the operator.
 */
export type JobErrorClass = 'recoverable' | 'fatal';

export interface QueuedJob {
  id: string;
  state: JobState;
  /** The class of the last failure; null while the job has not failed. */
  errorClass: JobErrorClass | null;
  lastError: string | null;
}

/**
 * Where a job stands. `queued` covers a job waiting for its first run and
 * one waiting out the pause before its next attempt; `dead` means it has
 * no attempts left.
 */
type JobState = 'queued' | 'running' | 'dead';

export type SideCostKind = Selectable<Database['billing.messageSideCosts']>['kind'];

/**
 * One Fact as a Seed renders it, with its category kept so a category the
 * user blocks later drops out of Seeds already frozen.
 */
export type SeedLine = Selectable<Database['memory.threadSeeds']>['lines'][number];

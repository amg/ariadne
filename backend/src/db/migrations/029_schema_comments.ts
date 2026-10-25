import { type Kysely, type RawBuilder, sql } from 'kysely';

interface TableDocs {
  table?: string;
  columns?: Record<string, string>;
}

/** What each table and column means. Keys are the database's snake_case names. */
const DOCS: Record<string, TableDocs> = {
  'chat.messages': {
    columns: {
      abandoned:
        'Set when a deliberate user action (an edit, a retry, a handover) takes the row out of the live conversation. The row stays in the Thread with its usage intact.',
      exchange_status:
        "Lifecycle of an assistant row's exchange: `pending` while the reply streams, terminal once it settles. Non-assistant rows keep the terminal default.",
    },
  },
  'billing.daily_spend': {
    table:
      "Daily spend: everything recorded as spent on one UTC day, across chat, embeddings and side calls, kept in several rows, and the day's spend is their sum. Kept current by the database whenever spend is written, and kept when the messages behind it are deleted.",
    columns: {
      day: 'The UTC day; written as `YYYY-MM-DD`, read back as a `Date`, never changed.',
      slot: "Which of the day's rows this is.",
    },
  },
  'billing.message_usage': {
    table:
      "The chat exchange's inference telemetry, linked 1:1 to `chat.messages`. `estimated` flags rows the exchange counted locally because the provider never reported usage (the exchange ended early); every other column is filled on both paths. The analyzer pipeline's spend lives elsewhere: every side call (rewrites, judges, Fact capture, and the embeddings themselves) carries its own row in `message_side_costs`.",
    columns: {
      estimated: 'True when tokens and cost were counted locally, not provider-reported.',
      provider_id: 'NULL when no provider response exists (estimated spends).',
      prompt_tokens: 'Counted locally on estimated rows, so never null.',
      completion_tokens: 'Counted locally on estimated rows, so never null.',
      cached_input_tokens: "NULL when the provider doesn't report cache telemetry.",
      cache_write_tokens: "NULL when the provider doesn't report cache telemetry.",
      reasoning_tokens:
        'Provider-reported reasoning tokens (some providers report 0 even when the model reasoned).',
      estimated_reasoning_tokens:
        'Our estimate from reasoning content length (NULL when no reasoning).',
    },
  },
  'billing.message_side_costs': {
    table:
      "Billed spend of the side pipelines, one row per (message, kind, model): the arrival's rewrite (expansion) step and its trigger judge, the Fact capture a Boundary arrival triggers (extraction, duplicate checks, and Fact embeddings, each summed across the segment's calls), and the message's embeddings, every pass that paid one summed under the `embedding` kind. Model attribution is fixed by the environment's pipeline models; the provider response id is not persisted for these calls.",
    columns: {
      prompt_tokens: 'NULL when the provider reported no token counts.',
      completion_tokens: 'NULL when the provider reported no token counts.',
    },
  },
  'billing.model_configs': {
    columns: {
      cached_rate_multiplier: 'Multiplier of the input price, for example 0.5 for half.',
    },
  },
  'analysis.message_embeddings': {
    table:
      'Thread-health embeddings, one row per Message and embedding model: a *Turn* row keys to the Turn\'s assistant Message ("state of the conversation ending at this message", NOT "this message"); an *arrival* row keys to the Turn\'s user Message, the arriving signal judged before inference. Vectors from different models are never compared; switching the model keeps the old rows and starts a parallel chain. The rewrite\'s reading and its spend live in `message_expansions` and `message_side_costs`.',
    columns: {
      message_id: '1:1 with the Message per model (PK, cascade delete).',
      embedding: 'A pgvector `vector(1024)`, read as its text form `[0.1,-0.2,…]`.',
    },
  },
  'analysis.message_expansions': {
    table:
      "One arrival's try at a self-contained rewrite: what the reading ended up as (`accepted`: it landed; `failed_*`: it did not, and why; `not_needed`: none was attempted, the raw message stood on its own), and the reading itself, present exactly when it landed.",
    columns: {
      expand_outcome:
        "The recorded end of one arrival's try at a rewrite: what the reading ended up as, and when no reading landed, why. The rewrite model refused, a quality check rejected it, the provider call failed, or the output was unusable. `not_needed` marks the arrivals whose raw message stood on its own, no rewrite attempted.",
      expanded_text: 'The self-contained rewrite; null on every other end.',
    },
  },
  'analysis.thread_segments': {
    table:
      "The live arrival chain the gate builds as the conversation progresses. A segment's end is simply the next segment's start (chronology), so there is no end column.",
    columns: {
      start_message_id: 'The first user Message of the segment.',
      model_id: 'The embedding model that made the reading which cut this segment.',
    },
  },
  'memory.memory_capture_progress': {
    table:
      "How far Fact capture has read a segment: Memory's own bookkeeping, kept out of the segmentation table. One row per segment that capture has taken in at least once.",
    columns: {
      captured_through_at: '`created_at` of the last Turn a capture pass read.',
    },
  },
  'analysis.segment_drift_logs': {
    table:
      "One row per judged arrival in the live lane: the composite reading judged against the segment it entered, plus the µ/σ/z snapshot of that segment's baseline exactly as it stood BEFORE the arrival joined it. Muted strides keep a row with null numbers. Keyed by the Message and the model, as one chain per embedding model runs.",
    columns: {
      segment_id: 'The segment the arrival was judged in.',
      message_id: 'The user Message that arrived.',
      model_id: 'The embedding model that made the judged reading.',
      drift_p: 'The composite reading judged; null on muted arrivals.',
      fire_channel: 'Which channel produced a fire; null otherwise.',
      slow_drift_start_message_id:
        "When `fire_channel` is 'slow', the message ID of the turn that anchored the Page-Hinkley low-water mark.",
      immediate_threshold:
        "The immediate criterion the reading was judged against: μ + k·max(σ, σ_floor) once the baseline warms, the flat T_segment while it bootstraps. Null exactly when `drift_p` is: muted arrivals judged nothing. Stored per row so the chart draws the line each point was actually judged against, not one recomputed from today's params.",
    },
  },
  'analysis.arrival_judgment_states': {
    table:
      "One judged arrival's gate state, stored so the next judgment starts from it instead of rebuilding the whole chain: the segment baseline (Welford moments) and the slow patrol (Page–Hinkley accumulator) as they stand AFTER the arrival was judged. Keyed to the arrival's drift log; the keep-two rule prunes all but the newest two arrivals' rows.",
    columns: {
      message_id: "The arrival's user Message, the one its drift log rides.",
      model_id: 'The embedding model whose chain was judged.',
      patrol_low_water: "The Page–Hinkley low-water mark's level; 0 while the patrol is empty.",
      patrol_low_water_message_id:
        'The sample that anchors the low-water mark; null while the patrol is empty.',
    },
  },
  'analysis.turn_folds': {
    table:
      "One folded Turn's gate state, stored so the next judgment measures against it instead of re-folding the chain: the current segment's summed geometry (full float64, so the sums accumulate bit-identically to a rebuild), the segment the conversation sits in, and how many Turns the live chain has folded. Keyed to the Turn's embedding row; the keep-two rule prunes all but the newest two Turns' rows.",
    columns: {
      message_id: "The Turn's assistant Message, the one its embedding rides.",
      model_id: 'The embedding model whose chain was folded.',
      segment_id: 'The segment the conversation sits in once this Turn folded.',
      gravity_sum:
        "Elementwise sum of the segment's folded Turn vectors, in full float64 with no rounding; its unit vector is the Gravity point.",
      anchor_sum:
        "Sum of the segment's first up-to-three folded Turn vectors: the anchor reading's base.",
      anchor_count: 'How many Turn vectors the anchor sum holds (1–3).',
      completed_turns:
        'Complete Turns the live chain has folded through this Turn: the cold-start and staleness counter.',
    },
  },
  'memory.user_facts': {
    table:
      'The Memory store: one self-contained sentence about the user per row. Rows are superseded by invalidation (`invalid_at`), never overwritten. Facts outlive Threads, so the source message reference nulls out when its Thread is deleted.',
    columns: {
      subject: 'Entity the Fact is about; "user" for the user themself.',
      predicate: 'Normalized snake_case relation, e.g. `lives_in`.',
      embedding: 'A pgvector `vector(1024)`, read as its text form `[0.1,-0.2,…]`.',
      source_message_id:
        'The user Message of the Turn the Fact came from; null once its Thread is gone.',
      valid_at:
        'When the Fact became true, as the conversation states it; null when it states none.',
      invalid_at: 'When the Fact stopped being current; null while it is.',
      suppressed: 'Kept in the store but never injected into a Seed.',
      created_at: 'When the Fact was noted: its capture, or the edit that replaced an older row.',
    },
  },
  'memory.thread_seeds': {
    table:
      "A Thread's Seed: the memory block frozen at Thread creation and prepended to the system prompt on every Exchange of that Thread.",
    columns: {
      lines:
        "The Seed's lines in render order, as a jsonb array. A line keeps its Fact's category, so a category the user blocks later drops out of Seeds already frozen.",
      handover_message_id:
        'The drift-paused arrival this Thread was handed over from; null otherwise.',
    },
  },
  'memory.user_settings': {
    table: 'Per-user settings document; missing and unknown keys resolve in code.',
  },
};

/**
 * Raw `sql` because the schema builder has no comment statement. The
 * text rides as a literal, since `COMMENT ON` cannot take a parameter.
 */
async function setComments({
  db,
  textOf,
}: {
  db: Kysely<any>;
  textOf: (doc: string) => RawBuilder<unknown>;
}) {
  for (const [table, docs] of Object.entries(DOCS)) {
    if (docs.table) {
      await sql`comment on table ${sql.table(table)} is ${textOf(docs.table)}`.execute(db);
    }
    for (const [column, doc] of Object.entries(docs.columns ?? {})) {
      await sql`comment on column ${sql.table(table)}.${sql.ref(column)} is ${textOf(doc)}`.execute(
        db,
      );
    }
  }
}

export async function up(db: Kysely<any>) {
  await setComments({ db, textOf: (doc) => sql.lit(doc) });
}

export async function down(db: Kysely<any>) {
  await setComments({ db, textOf: () => sql`null` });
}

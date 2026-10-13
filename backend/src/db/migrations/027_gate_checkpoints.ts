import { type Kysely, sql } from 'kysely';

/**
 * The gate's running state, stored as checkpoints.
 *
 * Judging one arrival cost a full rebuild of the gate's running state —
 * baseline, patrol, Gravity point — walking every stored arrival from
 * the first, so worker time grew with the Thread. Two tables end that:
 * `arrival_judgment_states` holds one judged arrival's baseline and
 * patrol as they stand after its judgment, `turn_folds` holds one folded
 * Turn's segment sums, its segment, and how many Turns the live chain
 * has folded. The next judgment reads the newest two instead of walking
 * the chain; keep-two pruning (the verdict's own transaction) keeps the
 * rest from piling up.
 *
 * `segment_drift_logs` gains the immediate criterion each verdict was
 * judged against, so the chart draws the line the point was judged on —
 * a parameter change afterwards no longer redraws history. Existing
 * rows are backfilled with the constants they were judged under: warm
 * baselines as μ + k·max(σ, σ_floor), bootstrapping ones as the flat
 * T_segment, muted rows (nothing judged) as null.
 *
 * Migrations reshape the schema the app's Database type never models, so
 * they ride the untyped connection Kysely's own Migrator hands them
 * (mid-migration shapes carry no app-side type, in any spelling). The
 * check constraint, the backfill and the composite keys are typed
 * builder DDL/DML; the rest is builder too.
 */

export async function up(db: Kysely<any>): Promise<void> {
  // 1. The criterion each verdict was judged against.
  await db.schema
    .withSchema('analysis')
    .alterTable('segment_drift_logs')
    .addColumn('immediate_threshold', 'double precision')
    .execute();
  await db
    .updateTable('analysis.segment_drift_logs')
    .set((eb) => ({
      // The constants the stored rows were judged under: warm baselines as
      // μ + k·max(σ, σ_floor), bootstrapping ones as the flat T_segment.
      immediateThreshold: eb
        .case()
        .when(eb.or([eb('mu', 'is', null), eb('sigma', 'is', null)]))
        .then(eb.lit(0.52))
        .else(sql`mu + 2.0::double precision * greatest(sigma, 0.08::double precision)`)
        .end(),
    }))
    .where('drift_p', 'is not', null)
    .execute();
  await db.schema
    .withSchema('analysis')
    .alterTable('segment_drift_logs')
    .addCheckConstraint(
      'segment_drift_logs_immediate_threshold_check',
      sql`(immediate_threshold is null) = (drift_p is null)`,
    )
    .execute();

  // 2. One judged arrival's baseline and patrol.
  await db.schema
    .withSchema('analysis')
    .createTable('arrival_judgment_states')
    .addColumn('message_id', 'uuid', (col) => col.notNull())
    .addColumn('model_id', 'text', (col) => col.notNull())
    .addColumn('baseline_count', 'integer', (col) => col.notNull())
    .addColumn('baseline_mean', 'double precision', (col) => col.notNull())
    .addColumn('baseline_m2', 'double precision', (col) => col.notNull())
    .addColumn('patrol_count', 'integer', (col) => col.notNull())
    .addColumn('patrol_sum', 'double precision', (col) => col.notNull())
    .addColumn('patrol_cumulative', 'double precision', (col) => col.notNull())
    .addColumn('patrol_low_water', 'double precision', (col) => col.notNull())
    .addColumn('patrol_low_water_message_id', 'uuid', (col) =>
      col.references('chat.messages.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('arrival_judgment_states_pkey', ['message_id', 'model_id'])
    .addForeignKeyConstraint(
      'arrival_judgment_states_drift_log_fkey',
      ['message_id', 'model_id'],
      'analysis.segment_drift_logs',
      ['message_id', 'model_id'],
      (fk) => fk.onDelete('cascade'),
    )
    .execute();

  // 3. One folded Turn's segment geometry.
  await db.schema
    .withSchema('analysis')
    .createTable('turn_folds')
    .addColumn('message_id', 'uuid', (col) => col.notNull())
    .addColumn('model_id', 'text', (col) => col.notNull())
    .addColumn('segment_id', 'uuid', (col) =>
      col.notNull().references('analysis.thread_segments.id').onDelete('cascade'),
    )
    .addColumn('gravity_sum', sql`double precision[]`, (col) => col.notNull())
    .addColumn('anchor_sum', sql`double precision[]`, (col) => col.notNull())
    .addColumn('anchor_count', 'integer', (col) =>
      col.notNull().check(sql`anchor_count between 1 and 3`),
    )
    .addColumn('completed_turns', 'integer', (col) => col.notNull().check(sql`completed_turns > 0`))
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('turn_folds_pkey', ['message_id', 'model_id'])
    .addForeignKeyConstraint(
      'turn_folds_embedding_fkey',
      ['message_id', 'model_id'],
      'analysis.message_embeddings',
      ['message_id', 'model_id'],
      (fk) => fk.onDelete('cascade'),
    )
    .execute();

  // Checked on every Message delete (a Thread delete's cascade included).
  await db.schema
    .withSchema('analysis')
    .createIndex('arrival_judgment_states_patrol_low_water_message_id_idx')
    .on('arrival_judgment_states')
    .column('patrol_low_water_message_id')
    .execute();
  await db.schema
    .withSchema('analysis')
    .createIndex('turn_folds_segment_id_idx')
    .on('turn_folds')
    .column('segment_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.withSchema('analysis').dropIndex('turn_folds_segment_id_idx').execute();
  await db.schema
    .withSchema('analysis')
    .dropIndex('arrival_judgment_states_patrol_low_water_message_id_idx')
    .execute();
  await db.schema.withSchema('analysis').dropTable('turn_folds').execute();
  await db.schema.withSchema('analysis').dropTable('arrival_judgment_states').execute();
  await db.schema
    .withSchema('analysis')
    .alterTable('segment_drift_logs')
    .dropConstraint('segment_drift_logs_immediate_threshold_check')
    .execute();
  await db.schema
    .withSchema('analysis')
    .alterTable('segment_drift_logs')
    .dropColumn('immediate_threshold')
    .execute();
}

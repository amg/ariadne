import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbFromPool } from '@db/db';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The gate-checkpoint schema's own contract, replayed for real: a
 * database at the previous shape (migrations up to and including the
 * analysis-keys one) is seeded with judged arrivals — muted, cold, and
 * warm baselines — migrated forward, and must backfill each verdict with
 * the immediate criterion it was judged under, in the exact double the
 * judgment's formula produces. The two checkpoint tables must hold their
 * shape: keys, cascades, and the guards that keep a checkpoint honest.
 * The replay then walks the move back and forth once: down restores the
 * previous shape, and the forward move replays the same backfill
 * bit-exact. The suite owns a scratch database — the shared test
 * database stays migrated for everyone else.
 */

const MODEL = 'seed/embed-model';
const UP_TO = '026_analysis_schema_final_keys';

const workerUrl = process.env.VITEST_TEST_DATABASE_URL;
const poolId = Number(process.env.VITEST_POOL_ID);
if (!workerUrl || !Number.isInteger(poolId) || poolId < 1) {
  throw new Error('expected the vitest worker database environment');
}

const scratchName = `chatbot_m027_w${poolId}`;
const scratchUrl = new URL(workerUrl);
scratchUrl.pathname = `/${scratchName}`;
const adminUrl = new URL(workerUrl);
adminUrl.pathname = '/postgres';

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

/** A 1024-dim unit axis: any fixed vector serves the shape assertions. */
const VECTOR = `[${Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0)).join(',')}]`;

let scratch: Pool;

/** Runs the tracked migrations on the scratch database up to `target`. */
async function migrateTo(target: string | undefined): Promise<void> {
  const db = createDbFromPool(scratch);
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: migrationsFolder,
    }),
  });
  const { error } =
    target === undefined ? await migrator.migrateToLatest() : await migrator.migrateTo(target);
  if (error) throw error;
}

/** The exact column list of a table's primary key, in key order. */
async function primaryKeyColumns(table: string): Promise<string[]> {
  const { rows } = await scratch.query(
    `select a.attname
       from pg_index i
       join pg_class c on c.oid = i.indrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
      where n.nspname = 'analysis' and c.relname = $1 and i.indisprimary
      order by a.attnum`,
    [table],
  );
  return rows.map((row: { attname: string }) => row.attname);
}

/** Column names of an analysis table, alphabetically. */
async function analysisColumns(table: string): Promise<string[]> {
  const { rows } = await scratch.query(
    `select column_name from information_schema.columns
      where table_schema = 'analysis' and table_name = $1
      order by column_name`,
    [table],
  );
  return rows.map((row: { column_name: string }) => row.column_name);
}

/** The seeded chain's ids: one thread, four messages, two segments. */
const ID = {
  user: '11111111-1111-1111-1111-111111111111',
  thread: '22222222-2222-2222-2222-222222222222',
  muted: '33333333-3333-3333-3333-333333333331',
  warmFloored: '33333333-3333-3333-3333-333333333332',
  warmAbove: '33333333-3333-3333-3333-333333333333',
  cold: '33333333-3333-3333-3333-333333333334',
  reply: '33333333-3333-3333-3333-333333333335',
  segmentOne: '44444444-4444-4444-4444-444444444441',
  segmentTwo: '44444444-4444-4444-4444-444444444442',
} as const;

/**
 * Seeds the previous shape: a thread with four judged arrivals — one
 * muted, two warm baselines (one under the σ floor, one above), one
 * cold-start — plus the reply embedding a Turn fold would key on.
 */
async function seedPreviousShape(): Promise<void> {
  await scratch.query('insert into chat.users (id) values ($1)', [ID.user]);
  await scratch.query(
    "insert into chat.threads (id, user_id, title) values ($1, $2, 'gate checkpoints')",
    [ID.thread, ID.user],
  );
  for (const [id, role] of [
    [ID.muted, 'user'],
    [ID.warmFloored, 'user'],
    [ID.warmAbove, 'user'],
    [ID.cold, 'user'],
    [ID.reply, 'assistant'],
  ] as const) {
    await scratch.query(
      "insert into chat.messages (id, thread_id, role, content) values ($1, $2, $3, 'seed')",
      [id, ID.thread, role],
    );
  }
  await scratch.query(
    `insert into analysis.thread_segments (id, thread_id, start_message_id, model_id)
     values ($1, $2, $3, $4), ($5, $6, $7, $8)`,
    [ID.segmentOne, ID.thread, ID.muted, MODEL, ID.segmentTwo, ID.thread, ID.warmAbove, MODEL],
  );
  // The muted arrival: nothing was judged, so no reading exists.
  await scratch.query(
    `insert into analysis.segment_drift_logs (segment_id, message_id, model_id, verdict)
     values ($1, $2, $3, 'muted')`,
    [ID.segmentOne, ID.muted, MODEL],
  );
  // A warm baseline under the σ floor: the floor carries the criterion.
  await scratch.query(
    `insert into analysis.segment_drift_logs
       (segment_id, message_id, model_id, verdict, fire_channel, drift_p, mu, sigma, z_score)
     values ($1, $2, $3, 'pass', null, 0.51, 0.5, 0.03, 0.2)`,
    [ID.segmentOne, ID.warmFloored, MODEL],
  );
  // A warm baseline above the floor: σ carries the criterion.
  await scratch.query(
    `insert into analysis.segment_drift_logs
       (segment_id, message_id, model_id, verdict, fire_channel, drift_p, mu, sigma, z_score)
     values ($1, $2, $3, 'pass', null, 0.6, 0.25, 0.125, 1.5)`,
    [ID.segmentTwo, ID.warmAbove, MODEL],
  );
  // A cold start: the flat T_segment judged it.
  await scratch.query(
    `insert into analysis.segment_drift_logs
       (segment_id, message_id, model_id, verdict, fire_channel, drift_p)
     values ($1, $2, $3, 'fire', 'immediate', 0.9)`,
    [ID.segmentTwo, ID.cold, MODEL],
  );
  await scratch.query(
    `insert into analysis.message_embeddings (message_id, embedding, model_id)
     values ($1, $2::vector, $3)`,
    [ID.reply, VECTOR, MODEL],
  );
}

beforeAll(async () => {
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    await admin.query(`drop database if exists "${scratchName}" with (force)`);
    await admin.query(`create database "${scratchName}"`);
  } finally {
    await admin.end();
  }
  scratch = new Pool({ connectionString: scratchUrl.toString(), max: 1 });
  await migrateTo(UP_TO);
  await seedPreviousShape();
  await migrateTo(undefined);
});

afterAll(async () => {
  await scratch.end();
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    await admin.query(`drop database if exists "${scratchName}" with (force)`);
  } finally {
    await admin.end();
  }
});

describe('migrating the gate to checkpointed judgments', () => {
  it('backfills each verdict with the criterion its own formula judged it under', async () => {
    const { rows } = await scratch.query(
      `select message_id, verdict, immediate_threshold::text from analysis.segment_drift_logs
        order by message_id`,
    );
    expect(rows).toEqual([
      // Muted: nothing judged, no line to draw.
      { message_id: ID.muted, verdict: 'muted', immediate_threshold: null },
      // Warm under the floor: μ + k·σ_floor, the same double the judgment
      // computes (both sides parse 0.08 to the same float8).
      {
        message_id: ID.warmFloored,
        verdict: 'pass',
        immediate_threshold: `${0.5 + 2 * Math.max(0.03, 0.08)}`,
      },
      // Warm above the floor: μ + k·σ.
      {
        message_id: ID.warmAbove,
        verdict: 'pass',
        immediate_threshold: `${0.25 + 2 * Math.max(0.125, 0.08)}`,
      },
      // Cold start: the flat T_segment.
      { message_id: ID.cold, verdict: 'fire', immediate_threshold: '0.52' },
    ]);
  });

  it('keeps a threshold exactly where a reading is, and only there', async () => {
    const broken = '55555555-5555-5555-5555-555555555551';
    await scratch.query(
      "insert into chat.messages (id, thread_id, role, content) values ($1, $2, 'user', 'seed')",
      [broken, ID.thread],
    );
    // A reading without its criterion, and a criterion without its
    // reading, are both refused: the pair is one fact.
    await expect(
      scratch.query(
        `insert into analysis.segment_drift_logs
           (segment_id, message_id, model_id, verdict, drift_p)
         values ($1, $2, $3, 'pass', 0.5)`,
        [ID.segmentOne, broken, MODEL],
      ),
    ).rejects.toThrow();
    await expect(
      scratch.query(
        `insert into analysis.segment_drift_logs
           (segment_id, message_id, model_id, verdict, immediate_threshold)
         values ($1, $2, $3, 'muted', 0.52)`,
        [ID.segmentOne, broken, MODEL],
      ),
    ).rejects.toThrow();
  });

  it('shapes the arrival judgment states: keyed by the verdict, patrolling by the message', async () => {
    expect(await primaryKeyColumns('arrival_judgment_states')).toEqual(['message_id', 'model_id']);
    await scratch.query(
      `insert into analysis.arrival_judgment_states
         (message_id, model_id, baseline_count, baseline_mean, baseline_m2,
          patrol_count, patrol_sum, patrol_cumulative, patrol_low_water,
          patrol_low_water_message_id)
       values ($1, $2, 3, 0.5, 0.1, 2, 1.0, -0.05, -0.05, $3)`,
      [ID.muted, MODEL, ID.cold],
    );

    // The verdict row is the state's anchor: deleting it deletes the state.
    await scratch.query(
      'delete from analysis.segment_drift_logs where message_id = $1 and model_id = $2',
      [ID.muted, MODEL],
    );
    const { rows: cascaded } = await scratch.query(
      'select count(*)::int as n from analysis.arrival_judgment_states',
    );
    expect(cascaded).toEqual([{ n: 0 }]);
  });

  it('drops the patrol anchor when its message goes, and keeps the state', async () => {
    await scratch.query(
      `insert into analysis.arrival_judgment_states
         (message_id, model_id, baseline_count, baseline_mean, baseline_m2,
          patrol_count, patrol_sum, patrol_cumulative, patrol_low_water,
          patrol_low_water_message_id)
       values ($1, $2, 0, 0, 0, 1, 0.7, -0.1, -0.1, $3)`,
      [ID.warmFloored, MODEL, ID.cold],
    );

    await scratch.query('delete from chat.messages where id = $1', [ID.cold]);

    const { rows } = await scratch.query(
      `select patrol_low_water_message_id from analysis.arrival_judgment_states
        where message_id = $1`,
      [ID.warmFloored],
    );
    expect(rows).toEqual([{ patrol_low_water_message_id: null }]);
  });

  it('shapes the Turn folds: keyed by the embedding, landing in a segment', async () => {
    expect(await primaryKeyColumns('turn_folds')).toEqual(['message_id', 'model_id']);
    await scratch.query(
      `insert into analysis.turn_folds
         (message_id, model_id, segment_id, gravity_sum, anchor_sum, anchor_count, completed_turns)
       values ($1, $2, $3, '{0.5,0.25}', '{0.5,0.25}', 1, 2)`,
      [ID.reply, MODEL, ID.segmentOne],
    );

    // A segment's folds go with the segment.
    await scratch.query('delete from analysis.thread_segments where id = $1', [ID.segmentOne]);
    const { rows: gone } = await scratch.query(
      'select count(*)::int as n from analysis.turn_folds',
    );
    expect(gone).toEqual([{ n: 0 }]);

    // The guards: an anchor count outside one to three, or a Turn count
    // that never happened, are refused.
    for (const bad of [
      `insert into analysis.turn_folds
         (message_id, model_id, segment_id, gravity_sum, anchor_sum, anchor_count, completed_turns)
       values ('${ID.reply}', '${MODEL}', '${ID.segmentTwo}', '{0.5}', '{0.5}', 0, 1)`,
      `insert into analysis.turn_folds
         (message_id, model_id, segment_id, gravity_sum, anchor_sum, anchor_count, completed_turns)
       values ('${ID.reply}', '${MODEL}', '${ID.segmentTwo}', '{0.5}', '{0.5}', 4, 1)`,
      `insert into analysis.turn_folds
         (message_id, model_id, segment_id, gravity_sum, anchor_sum, anchor_count, completed_turns)
       values ('${ID.reply}', '${MODEL}', '${ID.segmentTwo}', '{0.5}', '{0.5}', 1, 0)`,
    ]) {
      await expect(scratch.query(bad)).rejects.toThrow();
    }

    // A fold without its embedding anchor is refused too.
    await scratch.query('delete from analysis.message_embeddings where message_id = $1', [
      ID.reply,
    ]);
    await expect(
      scratch.query(
        `insert into analysis.turn_folds
           (message_id, model_id, segment_id, gravity_sum, anchor_sum, anchor_count, completed_turns)
         values ($1, $2, $3, '{0.5}', '{0.5}', 1, 1)`,
        [ID.reply, MODEL, ID.segmentTwo],
      ),
    ).rejects.toThrow();
  });

  it('round-trips: down restores the previous shape, and the move replays bit-exact', async () => {
    const before = await scratch.query(
      'select message_id, immediate_threshold::text as t from analysis.segment_drift_logs order by message_id',
    );

    await migrateTo(UP_TO);

    expect(await analysisColumns('segment_drift_logs')).not.toContain('immediate_threshold');
    await expect(scratch.query('select 1 from analysis.arrival_judgment_states')).rejects.toThrow();
    await expect(scratch.query('select 1 from analysis.turn_folds')).rejects.toThrow();

    await migrateTo(undefined);

    const after = await scratch.query(
      'select message_id, immediate_threshold::text as t from analysis.segment_drift_logs order by message_id',
    );
    expect(after.rows).toEqual(before.rows);
  });
});

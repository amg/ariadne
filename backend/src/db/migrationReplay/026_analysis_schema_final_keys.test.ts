import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbFromPool } from '@db/db';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The schema change's own contract, replayed for real: a database at the
 * previous shape (migrations up to and including the daily-spend one) is
 * seeded with spend and half-finished work, migrated forward, and must
 * keep its daily spend bit-exact while every row lands in the shape the
 * new queries read. The replay then walks the move back and forth once:
 * the down migration restores the previous shape with the spend still
 * exact, and the forward move replays cleanly over the restored rows.
 * The suite owns a scratch database for the replay — the shared test
 * database stays migrated for everyone else.
 */

const MODEL = 'seed/embed-model';
const UP_TO = '025_daily_spend';

const workerUrl = process.env.VITEST_TEST_DATABASE_URL;
const poolId = Number(process.env.VITEST_POOL_ID);
if (!workerUrl || !Number.isInteger(poolId) || poolId < 1) {
  throw new Error('expected the vitest worker database environment');
}

const scratchName = `chatbot_m026_w${poolId}`;
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
let spendBefore: unknown[];

/** Runs the tracked migrations on the scratch database up to `target`. */
async function migrateTo(target: string | undefined) {
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
async function primaryKeyColumns(table: string) {
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

/** The daily-spend ledger as rows of plain strings. */
async function dailySpend() {
  const { rows } = await scratch.query(
    'select day::text, cost_usd::text from billing.daily_spend order by day',
  );
  return rows;
}

/** Column names of an analysis table, alphabetically. */
async function analysisColumns(table: string) {
  const { rows } = await scratch.query(
    `select column_name from information_schema.columns
      where table_schema = 'analysis' and table_name = $1
      order by column_name`,
    [table],
  );
  return rows.map((row: { column_name: string }) => row.column_name);
}

/**
 * Seeds the old shape: chat telemetry, one side cost, arrival embeddings
 * carrying rewrite columns and spend, a Turn vector, a half-finished
 * arrival (outcome stored, vector never filled), and a live-chain verdict.
 */
async function seedOldShape() {
  const user = '11111111-1111-1111-1111-111111111111';
  const thread = '22222222-2222-2222-2222-222222222222';
  const u1 = '33333333-3333-3333-3333-333333333331';
  const a1 = '33333333-3333-3333-3333-333333333332';
  const u2 = '33333333-3333-3333-3333-333333333333';
  const u3 = '33333333-3333-3333-3333-333333333334';
  const segment = '44444444-4444-4444-4444-444444444441';
  await scratch.query('insert into chat.users (id) values ($1)', [user]);
  await scratch.query(
    "insert into chat.threads (id, user_id, title) values ($1, $2, 'migration round trip')",
    [thread, user],
  );
  for (const [id, role] of [
    [u1, 'user'],
    [a1, 'assistant'],
    [u2, 'user'],
    [u3, 'user'],
  ] as const) {
    await scratch.query(
      "insert into chat.messages (id, thread_id, role, content) values ($1, $2, $3, 'seed')",
      [id, thread, role],
    );
  }
  await scratch.query(
    `insert into billing.message_usage
       (message_id, model, prompt_tokens, completion_tokens, cost_usd, finish_reason)
     values ($1, 'chat/model', 10, 5, '0.0000050000', 'stop')`,
    [a1],
  );
  await scratch.query(
    `insert into billing.message_side_costs (message_id, kind, model, cost_usd)
     values ($1, 'rewrite', 'rw/model', '0.0000002000')`,
    [u1],
  );
  await scratch.query(
    `insert into analysis.message_embeddings
       (message_id, embedding, model_id, expanded_text, expand_outcome, embedding_cost_usd)
     values ($1, $2::vector, $3, 'the rewrite of one', 'accepted', '0.0000000100')`,
    [u1, VECTOR, MODEL],
  );
  await scratch.query(
    `insert into analysis.message_embeddings (message_id, embedding, model_id, embedding_cost_usd)
     values ($1, $2::vector, $3, '0.0000000200')`,
    [u2, VECTOR, MODEL],
  );
  await scratch.query(
    `insert into analysis.message_embeddings (message_id, embedding, model_id)
     values ($1, $2::vector, $3)`,
    [a1, VECTOR, MODEL],
  );
  await scratch.query(
    `insert into analysis.message_embeddings (message_id, embedding, model_id, expand_outcome)
     values ($1, null, $2, 'failed')`,
    [u3, MODEL],
  );
  await scratch.query(
    `insert into analysis.thread_segments (id, thread_id, start_message_id, model_id)
     values ($1, $2, $3, $4)`,
    [segment, thread, u1, MODEL],
  );
  await scratch.query(
    `insert into analysis.segment_drift_logs (segment_id, message_id, model_id, verdict)
     values ($1, $2, $3, 'muted')`,
    [segment, u1, MODEL],
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
  await seedOldShape();
  spendBefore = await dailySpend();
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

describe('migrating the analysis schema to its final keys', () => {
  it('keeps daily spend bit-exact while every row moves to its new shape', async () => {
    expect(spendBefore).toEqual([{ day: expect.any(String), cost_usd: '0.0000052300' }]);

    // The spend ledger is untouched by the move: the arrival embedding
    // costs now live in side-cost rows that were poured with their
    // trigger suspended.
    expect(await dailySpend()).toEqual(spendBefore);
  });

  it('moves the rewrite outcomes to message_expansions, untried rewrites included', async () => {
    const { rows } = await scratch.query(
      `select message_id, expand_outcome, expanded_text
         from analysis.message_expansions
        order by message_id`,
    );
    expect(rows).toEqual([
      {
        message_id: '33333333-3333-3333-3333-333333333331',
        expand_outcome: 'accepted',
        expanded_text: 'the rewrite of one',
      },
      {
        message_id: '33333333-3333-3333-3333-333333333333',
        expand_outcome: 'not_needed',
        expanded_text: null,
      },
      // The half-finished arrival: its reading survived, its vector did not.
      {
        message_id: '33333333-3333-3333-3333-333333333334',
        expand_outcome: 'failed',
        expanded_text: null,
      },
    ]);
  });

  it('pours the embedding spend into side costs under the embedding kind', async () => {
    const { rows } = await scratch.query(
      `select message_id, kind, model, cost_usd
         from billing.message_side_costs
        order by kind, message_id`,
    );
    expect(rows).toEqual([
      {
        message_id: '33333333-3333-3333-3333-333333333331',
        kind: 'embedding',
        model: MODEL,
        cost_usd: '0.0000000100',
      },
      {
        message_id: '33333333-3333-3333-3333-333333333333',
        kind: 'embedding',
        model: MODEL,
        cost_usd: '0.0000000200',
      },
      {
        message_id: '33333333-3333-3333-3333-333333333331',
        kind: 'rewrite',
        model: 'rw/model',
        cost_usd: '0.0000002000',
      },
    ]);
  });

  it('leaves message_embeddings with proven vectors only, keyed per model', async () => {
    const { rows } = await scratch.query(
      `select column_name from information_schema.columns
        where table_schema = 'analysis' and table_name = 'message_embeddings'
        order by column_name`,
    );
    expect(rows.map((row: { column_name: string }) => row.column_name)).toEqual([
      'created_at',
      'embedding',
      'message_id',
      'model_id',
    ]);

    expect(await primaryKeyColumns('message_embeddings')).toEqual(['message_id', 'model_id']);

    // The half-finished arrival is gone; the proven rows stayed.
    const { rows: embeddings } = await scratch.query(
      'select message_id, embedding is not null as has_vector from analysis.message_embeddings order by message_id',
    );
    expect(embeddings).toEqual([
      { message_id: '33333333-3333-3333-3333-333333333331', has_vector: true },
      { message_id: '33333333-3333-3333-3333-333333333332', has_vector: true },
      { message_id: '33333333-3333-3333-3333-333333333333', has_vector: true },
    ]);
  });

  it('keys the verdict rows by message and model, surrogate id gone', async () => {
    const { rows } = await scratch.query(
      `select column_name from information_schema.columns
        where table_schema = 'analysis' and table_name = 'segment_drift_logs'
        order by column_name`,
    );
    expect(rows.map((row: { column_name: string }) => row.column_name)).not.toContain('id');
    expect(rows.map((row: { column_name: string }) => row.column_name)).toContain('message_id');

    expect(await primaryKeyColumns('segment_drift_logs')).toEqual(['message_id', 'model_id']);

    const { rows: logs } = await scratch.query(
      'select message_id, verdict from analysis.segment_drift_logs',
    );
    expect(logs).toEqual([
      { message_id: '33333333-3333-3333-3333-333333333331', verdict: 'muted' },
    ]);
  });

  it('round-trips: down restores the previous shape, spend intact, and the move replays cleanly', async () => {
    await migrateTo(UP_TO);

    // The old columns ride the embedding rows again, `not_needed` back
    // to the null it was, and the reading of the half-finished arrival
    // is gone with its deleted row — the down move is honestly lossy
    // about exactly that.
    expect(await analysisColumns('message_embeddings')).toEqual([
      'created_at',
      'embedding',
      'embedding_cost_usd',
      'expand_outcome',
      'expanded_text',
      'message_id',
      'model_id',
    ]);
    expect(await primaryKeyColumns('message_embeddings')).toEqual(['message_id']);
    const { rows: restored } = await scratch.query(
      `select message_id, expand_outcome, expanded_text, embedding_cost_usd::text
         from analysis.message_embeddings order by message_id`,
    );
    expect(restored).toEqual([
      {
        message_id: '33333333-3333-3333-3333-333333333331',
        expand_outcome: 'accepted',
        expanded_text: 'the rewrite of one',
        embedding_cost_usd: '0.0000000100',
      },
      {
        message_id: '33333333-3333-3333-3333-333333333332',
        expand_outcome: null,
        expanded_text: null,
        embedding_cost_usd: null,
      },
      {
        message_id: '33333333-3333-3333-3333-333333333333',
        expand_outcome: null,
        expanded_text: null,
        embedding_cost_usd: '0.0000000200',
      },
    ]);

    // The verdict table is back on its surrogate id, the side costs hold
    // no embedding rows, and the spend ledger never noticed the move.
    expect(await analysisColumns('segment_drift_logs')).toContain('id');
    expect(await primaryKeyColumns('segment_drift_logs')).toEqual(['id']);
    await expect(scratch.query('select 1 from analysis.message_expansions')).rejects.toThrow();
    const { rows: sideCosts } = await scratch.query('select kind from billing.message_side_costs');
    expect(sideCosts).toEqual([{ kind: 'rewrite' }]);
    expect(await dailySpend()).toEqual(spendBefore);

    // The forward move replays cleanly over the restored rows: spend
    // still exact, and the two proven arrivals read back as expansions.
    await migrateTo(undefined);
    expect(await dailySpend()).toEqual(spendBefore);
    expect(await analysisColumns('message_embeddings')).toEqual([
      'created_at',
      'embedding',
      'message_id',
      'model_id',
    ]);
    const { rows: expansions } = await scratch.query(
      'select expand_outcome from analysis.message_expansions order by message_id',
    );
    expect(expansions).toEqual([{ expand_outcome: 'accepted' }, { expand_outcome: 'not_needed' }]);
  });
});

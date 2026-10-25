import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbFromPool } from '@db/db';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The slotted daily spend, migrated for real. A database at the previous
 * shape keeps every day's total in slot 0 when it migrates forward, and
 * spend written afterwards still adds up to the day's total. Moving down
 * and up again keeps every total. The suite owns a scratch database.
 */

const UP_TO = '027_gate_checkpoints';

const workerUrl = process.env.VITEST_TEST_DATABASE_URL;
const poolId = Number(process.env.VITEST_POOL_ID);
if (!workerUrl || !Number.isInteger(poolId) || poolId < 1) {
  throw new Error('expected the vitest worker database environment');
}

const scratchName = `chatbot_m028_w${poolId}`;
const scratchUrl = new URL(workerUrl);
scratchUrl.pathname = `/${scratchName}`;
const adminUrl = new URL(workerUrl);
adminUrl.pathname = '/postgres';

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

let scratch: Pool;

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

/** The ledger before slots, as rows of plain strings: the day and its amount. */
async function ledger() {
  const { rows } = await scratch.query(
    'select day::text, cost_usd::text from billing.daily_spend order by day',
  );
  return rows;
}

/** The ledger with slots, as rows of plain strings: the day, the slot and its amount. */
async function slottedLedger() {
  const { rows } = await scratch.query(
    'select day::text, slot, cost_usd::text from billing.daily_spend order by day, slot',
  );
  return rows;
}

/** The columns of the ledger's primary key, in key order. */
async function keyColumns() {
  const { rows } = await scratch.query(
    `select a.attname
       from pg_index i
       join pg_class c on c.oid = i.indrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
      where n.nspname = 'billing' and c.relname = 'daily_spend' and i.indisprimary
      order by a.attnum`,
  );
  return rows.map((row: { attname: string }) => row.attname);
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
  await scratch.query(
    `insert into billing.daily_spend (day, cost_usd)
     values ('2026-10-20', '1.2500000000'), ('2026-10-21', '0.0000030000')`,
  );
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

describe('migrating the daily spend into slots', () => {
  it('keeps every day’s total, in slot 0', async () => {
    expect(await slottedLedger()).toEqual([
      { day: '2026-10-20', slot: 0, cost_usd: '1.2500000000' },
      { day: '2026-10-21', slot: 0, cost_usd: '0.0000030000' },
    ]);
  });

  it('keys a row by its day and its slot', async () => {
    expect(await keyColumns()).toEqual(['day', 'slot']);
  });

  it('refuses a slot past the last one', async () => {
    await expect(
      scratch.query(
        "insert into billing.daily_spend (day, slot, cost_usd) values ('2026-10-22', 16, 1)",
      ),
    ).rejects.toThrow(/daily_spend_slot_check/);
  });

  it('adds spend written afterwards to the day it lands on', async () => {
    for (let spend = 0; spend < 20; spend += 1) {
      await scratch.query('select billing.add_daily_spend(0.5)');
    }

    const { rows } = await scratch.query(
      "select sum(cost_usd)::text as total, count(*)::int as slots from billing.daily_spend where day = (now() at time zone 'UTC')::date",
    );
    expect(rows[0].total).toBe('10.0000000000');
    expect(rows[0].slots).toBeGreaterThan(1);
  });
});

describe('moving the daily spend back and forth', () => {
  it('merges each day’s slots on the way down, and puts the totals in slot 0 on the way up', async () => {
    await scratch.query(
      "insert into billing.daily_spend (day, slot, cost_usd) values ('2026-10-20', 3, 0.7500000000), ('2026-10-20', 9, 2), ('2026-10-23', 3, 0.7500000000), ('2026-10-23', 9, 2)",
    );

    await migrateTo(UP_TO);
    const down = await ledger();
    expect(down).toContainEqual({ day: '2026-10-20', cost_usd: '4.0000000000' });
    expect(down).toContainEqual({ day: '2026-10-21', cost_usd: '0.0000030000' });
    // A day whose spend sat in slots other than 0 loses none of it.
    expect(down).toContainEqual({ day: '2026-10-23', cost_usd: '2.7500000000' });
    expect(await keyColumns()).toEqual(['day']);

    await migrateTo(undefined);
    const up = await slottedLedger();
    expect(up).toContainEqual({ day: '2026-10-20', slot: 0, cost_usd: '4.0000000000' });
    expect(up).toContainEqual({ day: '2026-10-23', slot: 0, cost_usd: '2.7500000000' });
    expect(await keyColumns()).toEqual(['day', 'slot']);
  });
});

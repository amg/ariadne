import { db } from '@db/db';
import { sql } from 'kysely';
import { afterAll, afterEach } from 'vitest';

/** Resolves once no queue job is running; one mid-write would race the clearing. */
async function queueJobsStopped(limitMs = 20_000) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const running = await db
      .selectFrom('queues.jobs')
      .select('id')
      .where('lockedAt', 'is not', null)
      .executeTakeFirst();
    if (!running || Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface CatalogTable {
  id: string;
  schema: string;
  name: string;
  /** Ids of the tables this one holds foreign keys into, itself excluded. */
  parents: readonly string[];
}

/**
 * Every table a test can fill: those in the domain schemas, plus the
 * queue's jobs. Migration bookkeeping in `public` and the queue engine's
 * own tables stay untouched.
 */
async function listFillableTables(): Promise<readonly CatalogTable[]> {
  // The system catalogs have no place in the app's typed schema.
  const { rows } = await sql<CatalogTable>`
    select c.oid::text as id, n.nspname as schema, c.relname as name,
      array(
        select k.confrelid::text from pg_constraint k
        where k.conrelid = c.oid and k.contype = 'f' and k.confrelid <> c.oid
      ) as parents
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r'
      and (
        (n.nspname not in ('public', 'queues', 'information_schema') and n.nspname not like 'pg\_%')
        or (n.nspname = 'queues' and c.relname = '_private_jobs')
      )
  `.execute(db);
  return rows;
}

/**
 * Orders the tables so each comes before every table it references. Rows
 * that hold a foreign key are then deleted before the rows they point at.
 */
function childrenFirst(tables: readonly CatalogTable[]): readonly CatalogTable[] {
  const byId = new Map(tables.map((table) => [table.id, table]));
  const visited = new Set<string>();
  const parentsFirst: CatalogTable[] = [];
  const visit = (id: string): void => {
    const table = byId.get(id);
    if (!table || visited.has(id)) return;
    visited.add(id);
    for (const parent of table.parents) visit(parent);
    parentsFirst.push(table);
  };
  for (const table of tables) visit(table.id);
  return parentsFirst.reverse();
}

let clearingOrder: readonly CatalogTable[] | undefined;

/**
 * Empties every table a test can fill. The tables come from the database
 * itself, so a table added by a migration is cleared without being listed
 * here.
 */
async function cleanDatabase() {
  clearingOrder ??= childrenFirst(await listFillableTables());
  const deletes = clearingOrder.map(
    (table) => sql`delete from ${sql.id(table.schema, table.name)}`,
  );
  await sql.join(deletes, sql`; `).execute(db);
}

/**
 * Test-lifecycle hook: queries and services use the app singleton from
 * `src/db/db.ts`, which the vitest global setup points at the provisioned
 * test database via `VITEST_TEST_DATABASE_URL`. Call once per test file at
 * collection time; it empties every table between tests and releases the
 * pg pool afterwards (an idle pool would keep the worker process alive).
 * Queue jobs still running finish first: one still writing would race the
 * clearing.
 */
export function useTestDb() {
  afterEach(async () => {
    await queueJobsStopped();
    await cleanDatabase();
  });

  afterAll(async () => {
    await db.destroy();
  });
}

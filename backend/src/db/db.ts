import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '@config/env';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import type { Database } from './types';

/**
 * Build a Kysely instance around an existing pg pool.
 *
 * Code-side camelCase identifiers map onto the snake_case schema and
 * result rows map back to camelCase. Raw `sql` templates pass through
 * untouched, SQL and result rows alike.
 */
export function createDbFromPool(pool: Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}

/**
 * Per-request database selection: a benched request enters a bench scope;
 * everything outside a scoped request keeps the default pool.
 */
export const requestDbScope = new AsyncLocalStorage<Kysely<Database>>();

/** The default database: a standing pool on DATABASE_URL. */
const mainDb = createDbFromPool(new Pool({ connectionString: env.DATABASE_URL }));

/** The bench database: a standing pool on BENCH_DATABASE_URL, null if unset. */
const benchDb: Kysely<Database> | null = env.BENCH_DATABASE_URL
  ? createDbFromPool(new Pool({ connectionString: env.BENCH_DATABASE_URL }))
  : null;

/** Whether this deployment has a bench database to switch to. */
export const isBenchDbConfigured = benchDb !== null;

/** Enters the bench scope for the current request context; no-op if unset. */
export function enterBenchScope(): boolean {
  if (!benchDb) return false;
  requestDbScope.enterWith(benchDb);
  return true;
}

/**
 * The app-wide database handle.
 *
 * Every access resolves against the bench database when the current request
 * is bench-scoped, else against the default — the swap stays invisible to
 * callers. `migrateToLatest` never touches the bench database: migrations
 * belong to the deployment's own schema.
 */
const resolveActiveDb = (): Kysely<Database> => requestDbScope.getStore() ?? mainDb;
export const db: Kysely<Database> = new Proxy(mainDb, {
  get(_target, prop) {
    const active = resolveActiveDb();
    const value = Reflect.get(active, prop);
    return typeof value === 'function' ? value.bind(active) : value;
  },
});

export async function migrateToLatest() {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  if (results) {
    for (const it of results) {
      if (it.status === 'Success') {
        console.log(`migration "${it.migrationName}" was executed successfully`);
      } else if (it.status === 'Error') {
        console.error(`failed to execute migration "${it.migrationName}"`);
      }
    }
  }

  if (error) {
    console.error('failed to migrate');
    console.error(error);
    process.exit(1);
  }
}

// If run directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  migrateToLatest().then(() => {
    console.log('Migrations complete');
    process.exit(0);
  });
}

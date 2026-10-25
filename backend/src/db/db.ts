import '@config/dotenv';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '@config/env';
import { CamelCasePlugin, Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { appPoolSize } from './poolSize';
import { TaggingPostgresDialect } from './queryTag';
import type { Database } from './types';

/**
 * Build a Kysely instance around an existing pg pool.
 *
 * Code-side camelCase identifiers map onto the snake_case schema and
 * result rows map back to camelCase. Raw `sql` templates pass through
 * untouched, SQL and result rows alike.
 */
export function createDbFromPool(pool: Pool) {
  return new Kysely<Database>({
    dialect: new TaggingPostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}

/**
 * Per-request database selection: a request that enters a scope runs its queries on the
 * handle the scope holds. Everything outside a scope uses the default pool.
 */
export const requestDbScope = new AsyncLocalStorage<Kysely<Database>>();

/** The default database's pool: standing, on DATABASE_URL, sized for the jobs this process runs. */
const mainPool = new Pool({
  connectionString: env.DATABASE_URL,
  max: appPoolSize(env.PROCESS_ROLE, env.WORKER_JOB_CONCURRENCY),
});
const mainDb = createDbFromPool(mainPool);

/** How many connections are lent out now, and how many requests are waiting for a free one. */
export function databaseConnections() {
  return { inUse: mainPool.totalCount - mainPool.idleCount, waiting: mainPool.waitingCount };
}

/**
 * The app-wide database handle.
 *
 * Every access resolves against the database of the current request scope, else
 * against the default, so the swap stays invisible to callers.
 */
const resolveActiveDb = () => requestDbScope.getStore() ?? mainDb;
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

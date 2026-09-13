import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import type { Database } from './types';

/**
 * Build a Kysely instance around an existing pg pool.
 */
export function createDbFromPool(pool: Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

/**
 * Resolve the connection from the environment at import time:
 *   1. `VITEST_TEST_DATABASE_URL` — set by the vitest global setup so every
 *      query/service under test binds to the provisioned test database.
 *   2. `DATABASE_URL` — standard single-string connection (deployment).
 *   3. `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` parts (dev).
 *
 * The pg Pool connects lazily, so merely importing this module never opens a
 * connection.
 */
function createPool(): Pool {
  const url = process.env.VITEST_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (url) {
    return new Pool({ connectionString: url });
  }
  return new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    database: process.env.DB_NAME || 'chatbot',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgrespassword',
    port: Number(process.env.DB_PORT) || 5432,
  });
}

/**
 * The app-wide connection singleton. Query modules import it directly;
 * services no longer receive or pass a Kysely instance. The one exception is
 * `test/global-setup.ts`, which builds its own short-lived instance to reset
 * the schema before workers start.
 */
export const pool = createPool();
export const db = createDbFromPool(pool);

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

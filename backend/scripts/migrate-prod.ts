/**
 * Production migration script — explicitly loads .env.prod before running migrations.
 * Usage: npm run migrate:prod
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '@config/env';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import type { Database } from '../src/db/types';

function createDbFromPool(pool: Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}

async function migrateToLatest() {
  // Build DATABASE_URL from prod env parts if not explicitly set
  const databaseUrl =
    process.env.DATABASE_URL ||
    `postgres://${encodeURIComponent(env.DB_USER)}:${encodeURIComponent(env.DB_PASSWORD)}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`;

  console.log(`Running migrations on: ${databaseUrl.replace(/:\/\/.*:.*@/, '://***:***@')}`);

  const pool = new Pool({ connectionString: databaseUrl });
  const db = createDbFromPool(pool);

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../src/db/migrations',
      ),
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
    await pool.end();
    process.exit(1);
  }

  await pool.end();
  console.log('Production migrations complete');
}

migrateToLatest()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

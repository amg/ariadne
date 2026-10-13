/**
 * Applies pending migrations to the production database.
 *
 * `npm run migrate:prod` points the config loader at `.env.prod`.
 * Connection parts may be overridden to reach the database from another
 * machine; the database itself may not be — a run is refused unless it
 * will connect to the database `.env.prod` names in DB_NAME.
 */
import '@config/dotenv';
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

/**
 * The DB_NAME declared in the repo's `.env.prod`.
 */
async function prodDatabaseName(): Promise<string> {
  const envProdPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.env.prod');
  const envProd = await fs.readFile(envProdPath, 'utf8');
  const match = envProd.match(/^DB_NAME=(.*)$/m);
  const declared = match?.[1];
  if (declared === undefined) {
    throw new Error(`No DB_NAME found in ${envProdPath}`);
  }
  return declared.trim().replace(/^["']|["']$/g, '');
}

async function migrateToLatest() {
  const expected = await prodDatabaseName();
  if (env.DB_NAME !== expected) {
    console.error(
      `Refusing to migrate: resolved DB_NAME is "${env.DB_NAME}", but this script only migrates "${expected}" (DB_NAME in .env.prod). Run it as npm run migrate:prod.`,
    );
    process.exit(1);
  }

  const databaseUrl = `postgres://${encodeURIComponent(env.DB_USER)}:${encodeURIComponent(env.DB_PASSWORD)}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`;

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

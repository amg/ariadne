import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import type { Database } from './types';

// Connection singleton
export const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  database: process.env.DB_NAME || 'chatbot',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgrespassword',
  port: Number(process.env.DB_PORT) || 5432,
});

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});

export async function migrateToLatest() {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(__dirname, 'migrations'),
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
if (require.main === module) {
  migrateToLatest().then(() => {
    console.log('Migrations complete');
    process.exit(0);
  });
}

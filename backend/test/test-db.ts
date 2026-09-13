import { createDbFromPool } from '@db/db';
import type { Database } from '@db/types';
import { type Kysely, sql } from 'kysely';
import { Pool } from 'pg';
import { afterAll, afterEach } from 'vitest';

const DB_URL_ENV = 'VITEST_TEST_DATABASE_URL';

export function createTestDatabase(): Kysely<Database> {
  const url = process.env[DB_URL_ENV];
  if (!url) {
    throw new Error(
      `Missing ${DB_URL_ENV}. Did the vitest global setup (test/global-setup.ts) run?`,
    );
  }
  return createDbFromPool(new Pool({ connectionString: url }));
}

export async function cleanDatabase(db: Kysely<Database>): Promise<void> {
  await sql`truncate table messages, threads, users cascade`.execute(db);
}

/**
 * Test-lifecycle helper: one real database connection per test file, wiped
 * between tests. No mocks anywhere — every test runs against the real
 * Postgres provisioned by test/global-setup.ts.
 *
 * The pg Pool connects lazily, so it is safe to create the instance at
 * collection time: `const db = useTestDb();`
 */
export function useTestDb(): Kysely<Database> {
  const instance = createTestDatabase();

  afterAll(async () => {
    await instance.destroy();
  });

  afterEach(async () => {
    await cleanDatabase(instance);
  });

  return instance;
}

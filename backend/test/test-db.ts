import { db } from '@db/db';
import { capturesSettled } from '@services/memory';
import { sql } from 'kysely';
import { afterAll, afterEach } from 'vitest';

export async function cleanDatabase(): Promise<void> {
  await sql`truncate table messages, message_embeddings, thread_segments, segment_drift_logs, threads, users, model_configs cascade`.execute(
    db,
  );
  // The queue's jobs live in the engine's own tables; no view can clear them.
  await sql`truncate table queues._private_jobs`.execute(db);
}

/**
 * Test-lifecycle hook: queries and services use the app singleton from
 * `src/db/db.ts`, which the vitest global setup points at the provisioned
 * test database via `VITEST_TEST_DATABASE_URL`. Call once per test file at
 * collection time; it truncates between tests and releases the pg pool
 * afterwards (an idle pool would keep the worker process alive). Fact
 * captures a test fired in the background finish first: one still writing
 * would deadlock against the truncate or outlive the pool.
 */
export function useTestDb(): void {
  afterEach(async () => {
    await capturesSettled();
    await cleanDatabase();
  });

  afterAll(async () => {
    await capturesSettled();
    await db.destroy();
  });
}

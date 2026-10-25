/**
 * Per-worker test databases: every vitest worker owns a clone of the
 * migrated test database, so files running in parallel never see each
 * other's rows or clear them.
 */

/** Env var carrying the migrated template database's URL to the workers. */
export const TEMPLATE_DB_URL_ENV = 'VITEST_TEST_DATABASE_TEMPLATE_URL';

/** Env var the app's config reads its database URL from under vitest. */
export const DB_URL_ENV = 'VITEST_TEST_DATABASE_URL';

/** Name of the clone owned by the worker with the given pool id (1-based). */
export function workerDatabaseName(templateName: string, poolId: number) {
  return `${templateName}_w${poolId}`;
}

/** The template URL with its database swapped for the worker's clone. */
export function workerDatabaseUrl(templateUrl: string, poolId: number) {
  const url = new URL(templateUrl);
  const templateName = decodeURIComponent(url.pathname.slice(1));
  url.pathname = `/${encodeURIComponent(workerDatabaseName(templateName, poolId))}`;
  return url.toString();
}

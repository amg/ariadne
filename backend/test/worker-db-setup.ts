// Runs in each worker before any test file imports the app's database
// module, which resolves its connection URL at import time.
import { DB_URL_ENV, TEMPLATE_DB_URL_ENV, workerDatabaseUrl } from './worker-db';

const templateUrl = process.env[TEMPLATE_DB_URL_ENV];
const poolId = Number(process.env.VITEST_POOL_ID);
if (!templateUrl || !Number.isInteger(poolId) || poolId < 1) {
  throw new Error(
    `[test-db] worker cannot resolve its database (${TEMPLATE_DB_URL_ENV}=${templateUrl}, VITEST_POOL_ID=${process.env.VITEST_POOL_ID})`,
  );
}
process.env[DB_URL_ENV] = workerDatabaseUrl(templateUrl, poolId);

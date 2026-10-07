import { db } from '@db/db';
import type { DbExecutor } from '@db/types';

/**
 * Runs the work in one transaction: every write made through the handle it
 * receives commits together, or none does when the work throws.
 */
export async function inTransaction<T>(work: (trx: DbExecutor) => Promise<T>): Promise<T> {
  return db.transaction().execute(work);
}

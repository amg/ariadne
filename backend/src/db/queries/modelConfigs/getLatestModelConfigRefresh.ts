import { db } from '@db/db';

/**
 * The newest `last_updated` across all model configs — the shared "last
 * refresh" marker used for the stateless refresh cooldown. Undefined when
 * no configs have been loaded yet.
 */
export async function getLatestModelConfigRefresh() {
  const row = await db
    .selectFrom('billing.modelConfigs')
    .select((eb) => eb.fn.max<Date>('lastUpdated').as('latest'))
    .executeTakeFirst();
  return row?.latest ?? undefined;
}

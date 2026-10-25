import { db } from '@db/db';

/** The sign-in emails of the home load accounts, `user-000000@load.invalid` and on. */
const LOAD_ACCOUNT_EMAIL_PATTERN = '%@load.invalid';

/**
 * Deletes everything the load accounts have built up: their Threads with
 * every Message, usage row and analysis row under them, their memory Facts
 * and their settings. The accounts stay signed up, and no other user's
 * data is touched.
 */
export async function deleteLoadAccountData() {
  return db.transaction().execute(async (trx) => {
    const loadAccountIds = trx
      .selectFrom('auth.emailpasswordUsers')
      .select((eb) => eb.cast<string>('userId', 'uuid').as('id'))
      .where('email', 'like', LOAD_ACCOUNT_EMAIL_PATTERN);

    const facts = await trx
      .deleteFrom('memory.userFacts')
      .where('userId', 'in', loadAccountIds)
      .executeTakeFirst();
    const settings = await trx
      .deleteFrom('memory.userSettings')
      .where('userId', 'in', loadAccountIds)
      .executeTakeFirst();
    const threads = await trx
      .deleteFrom('chat.threads')
      .where('userId', 'in', loadAccountIds)
      .executeTakeFirst();

    return {
      threads: Number(threads.numDeletedRows),
      facts: Number(facts.numDeletedRows),
      settings: Number(settings.numDeletedRows),
    };
  });
}

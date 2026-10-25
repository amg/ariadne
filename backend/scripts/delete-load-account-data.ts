/**
 * Deletes what the load accounts have built up, and prints how much went.
 *
 * Usage: npm run load:clean --workspace=backend
 */
import '@config/dotenv';
import { deleteLoadAccountData } from '@queries/loadAccounts/deleteLoadAccountData';

deleteLoadAccountData()
  .then(({ threads, facts, settings }) => {
    console.log(
      `Deleted ${threads} Thread(s), ${facts} Fact(s) and ${settings} settings document(s) of the load accounts.`,
    );
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });

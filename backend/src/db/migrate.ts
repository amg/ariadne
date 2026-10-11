/**
 * `npm run migrate`: applies pending migrations, then exits.
 *
 * Kept out of db.ts on purpose. A bundle inlines db.ts into the server, and
 * there every module shares the bundle's `import.meta.url`, so a "was I run
 * directly?" check inside db.ts would fire and migrate the server away.
 */
import { migrateToLatest } from './db';

await migrateToLatest();
console.log('Migrations complete');
process.exit(0);

import { randomUUID } from 'node:crypto';
import { env } from '@config/env';
import { db } from '@db/db';
import { setJobInsertNotifications } from '@queries/queue/setJobInsertNotifications';
import { inTransaction } from '@queries/transaction/inTransaction';
import { enqueueThreadGenerateTitle } from '@queue/tasks/threadGenerateTitleTask';
import { useTestDb } from '@test/test-db';
import { sql } from 'kysely';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

useTestDb();

/** The schema the queue keeps its tables in, as the queries in this folder name it. */
const QUEUE_SCHEMA = 'queues';

const titling = () => ({ userId: randomUUID(), threadId: randomUUID(), forced: false });

let listener: Client;
let heard: string[];

beforeEach(async () => {
  heard = [];
  listener = new Client({ connectionString: env.DATABASE_URL });
  await listener.connect();
  listener.on('notification', (message) => heard.push(message.payload ?? ''));
  await listener.query('listen "jobs:insert"');
});

afterEach(async () => {
  await listener.end();
  await setJobInsertNotifications({ schema: QUEUE_SCHEMA, notify: true });
});

/** How many notifications the listener heard, once every one committed so far has reached it. */
async function notificationCount() {
  await listener.query('select 1');
  return heard.length;
}

/** Adds one job on its own and one inside a transaction. */
async function addTwoJobs() {
  await enqueueThreadGenerateTitle(titling());
  await inTransaction((trx) => enqueueThreadGenerateTitle(titling(), trx));
}

describe('adding a job', () => {
  it('notifies workers while notifications are on', async () => {
    await addTwoJobs();

    expect(await notificationCount()).toBe(2);
  });

  it('notifies no worker once they are off, on its own or inside a transaction', async () => {
    expect(await setJobInsertNotifications({ schema: QUEUE_SCHEMA, notify: false })).toEqual([]);

    await addTwoJobs();

    expect(await notificationCount()).toBe(0);
  });

  it('notifies workers again once they are back on', async () => {
    await setJobInsertNotifications({ schema: QUEUE_SCHEMA, notify: false });
    await setJobInsertNotifications({ schema: QUEUE_SCHEMA, notify: true });

    await addTwoJobs();

    expect(await notificationCount()).toBe(2);
  });
});

describe('setJobInsertNotifications', () => {
  const scratch = 'job_insert_notifications_probe';

  /** Adds a function to the scratch schema, written the way the queue's own functions are. */
  async function addProbe(body: string) {
    await sql
      .raw(
        `create function ${scratch}.add_probe(n integer) returns integer language plpgsql as $$
         begin
         ${body}
           return n;
         end $$`,
      )
      .execute(db);
  }

  async function probeResult() {
    const { rows } = await sql<{ n: number }>`select ${sql.id(scratch)}.add_probe(3) as n`.execute(
      db,
    );
    return rows;
  }

  beforeEach(async () => {
    await sql`create schema ${sql.id(scratch)}`.execute(db);
  });

  afterEach(async () => {
    await sql`drop schema if exists ${sql.id(scratch)} cascade`.execute(db);
  });

  it('switches a function off and on again, twice over, and leaves what it does', async () => {
    await addProbe(`
           if n > 0 then
             perform pg_notify('jobs:insert', '{"count":' || n::text || '}');
           end if;
           perform pg_notify('jobs:insert', '{"r":' || random()::text || '}');`);

    await setJobInsertNotifications({ schema: scratch, notify: false });
    await setJobInsertNotifications({ schema: scratch, notify: false });
    expect(await probeResult()).toEqual([{ n: 3 }]);
    expect(await notificationCount()).toBe(0);

    await setJobInsertNotifications({ schema: scratch, notify: true });
    await setJobInsertNotifications({ schema: scratch, notify: true });
    expect(await probeResult()).toEqual([{ n: 3 }]);
    expect(await notificationCount()).toBe(2);
  });

  it('names a function whose notification it does not recognise', async () => {
    await addProbe(`
           if n > 0 then perform pg_notify('jobs:insert', '{}'); end if;`);

    expect(await setJobInsertNotifications({ schema: scratch, notify: false })).toEqual([
      `${scratch}.add_probe(integer)`,
    ]);
  });
});

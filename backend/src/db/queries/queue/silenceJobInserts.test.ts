import { randomUUID } from 'node:crypto';
import { env } from '@config/env';
import { db } from '@db/db';
import { silenceJobInserts } from '@queries/queue/silenceJobInserts';
import { inTransaction } from '@queries/transaction/inTransaction';
import { enqueueThreadGenerateTitle } from '@queue/tasks/threadGenerateTitleTask';
import { useTestDb } from '@test/test-db';
import { sql } from 'kysely';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

useTestDb();

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
});

/** What the listener heard, once every notification committed so far has reached it. */
async function notifications() {
  await listener.query('select 1');
  return heard;
}

describe('adding a job', () => {
  it('notifies no worker, on its own or inside a transaction', async () => {
    await enqueueThreadGenerateTitle(titling());
    await inTransaction((trx) => enqueueThreadGenerateTitle(titling(), trx));
    await sql`select pg_notify('jobs:insert', 'probe')`.execute(db);

    expect(await notifications()).toEqual(['probe']);
  });
});

describe('silenceJobInserts', () => {
  const scratch = 'silence_job_inserts_probe';

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

  beforeEach(async () => {
    await sql`create schema ${sql.id(scratch)}`.execute(db);
  });

  afterEach(async () => {
    await sql`drop schema if exists ${sql.id(scratch)} cascade`.execute(db);
  });

  it('stops a function notifying and leaves what it does', async () => {
    await addProbe(`
           if n > 0 then
             perform pg_notify('jobs:insert', '{"count":' || n::text || '}');
           end if;
           perform pg_notify('jobs:insert', '{"r":' || random()::text || '}');`);

    expect(await silenceJobInserts({ schema: scratch })).toEqual([]);
    expect(await silenceJobInserts({ schema: scratch })).toEqual([]);

    const { rows } = await sql<{ n: number }>`select ${sql.id(scratch)}.add_probe(3) as n`.execute(
      db,
    );
    expect(rows).toEqual([{ n: 3 }]);
    expect(await notifications()).toEqual([]);
  });

  it('names a function whose notification it does not recognise', async () => {
    await addProbe(`
           if n > 0 then perform pg_notify('jobs:insert', '{}'); end if;`);

    expect(await silenceJobInserts({ schema: scratch })).toEqual([`${scratch}.add_probe(integer)`]);
  });
});

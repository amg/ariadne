import { db } from '@db/db';
import { tagQuery } from '@db/queryTag';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

/** The SQL text Postgres received for the query that asked. */
async function sentSql(executor: typeof db) {
  const row = await executor
    .selectNoFrom((eb) => eb.fn<string>('current_query', []).as('sent'))
    .executeTakeFirstOrThrow();
  return row.sent;
}

describe('tagQuery', () => {
  useTestDb();

  it('sends the query file name ahead of the SQL', async () => {
    const sent = await sentSql(db.withPlugin(tagQuery('messages/listMessagesByThread')));

    expect(sent).toBe('/* query:messages/listMessagesByThread */ select current_query() as "sent"');
  });

  it('leaves an untagged query as it was', async () => {
    await sentSql(db.withPlugin(tagQuery('messages/listMessagesByThread')));

    expect(await sentSql(db)).toBe('select current_query() as "sent"');
  });

  it('refuses a name that could close the comment', () => {
    expect(() => tagQuery('messages/*/ drop table x')).toThrow('is not a query file name');
  });
});

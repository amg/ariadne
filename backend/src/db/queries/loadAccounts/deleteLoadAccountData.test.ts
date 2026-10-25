import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import { deleteLoadAccountData } from '@queries/loadAccounts/deleteLoadAccountData';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserFact } from '@queries/userFacts/insertUserFact';
import { saveUserSettingsDocument } from '@queries/userSettings/saveUserSettingsDocument';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { useTestDb } from '@test/test-db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

useTestDb();

/** The auth provider's own table does not exist in the test database, so the test makes one like it. */
beforeAll(async () => {
  await db.schema.createSchema('auth').ifNotExists().execute();
  await db.schema
    .createTable('auth.emailpassword_users')
    .ifNotExists()
    .addColumn('user_id', 'char(36)', (col) => col.primaryKey())
    .addColumn('email', 'varchar(256)', (col) => col.notNull())
    .execute();
});

afterEach(async () => {
  await db.deleteFrom('auth.emailpasswordUsers').execute();
});

async function signUp(email: string): Promise<string> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  await db.insertInto('auth.emailpasswordUsers').values({ userId, email }).execute();
  return userId;
}

async function buildUp(userId: string) {
  const thread = await insertThread({ userId, title: 'Built up' });
  await insertMessage({ threadId: thread.id, role: 'user', content: 'hello' });
  const reply = await insertMessage({ threadId: thread.id, role: 'assistant', content: 'hi' });
  await insertMessageUsage({
    messageId: reply.id,
    model: 'provider/chat',
    providerId: randomUUID(),
    promptTokens: 10,
    completionTokens: 5,
    costUsd: '0.0000050000',
    finishReason: 'stop',
  });
  await insertUserFact({
    userId,
    content: 'Likes sourdough',
    category: 'preference',
    subject: null,
    predicate: null,
    object: null,
    embedding: new Array<number>(1024).fill(0),
    modelId: EMBEDDING_MODEL_ID,
    sourceMessageId: null,
    validAt: new Date(),
  });
  await saveUserSettingsDocument({ userId, settings: { memory: true } });
}

async function countsOf(userId: string) {
  const count = async (table: 'chat.threads' | 'memory.userFacts' | 'memory.userSettings') => {
    const row = await db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll<string>().as('rows'))
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    return Number(row.rows);
  };
  const messages = await db
    .selectFrom('chat.messages')
    .innerJoin('chat.threads', 'chat.threads.id', 'chat.messages.threadId')
    .select((eb) => eb.fn.countAll<string>().as('rows'))
    .where('chat.threads.userId', '=', userId)
    .executeTakeFirstOrThrow();
  const usage = await db
    .selectFrom('billing.messageUsage')
    .innerJoin('chat.messages', 'chat.messages.id', 'billing.messageUsage.messageId')
    .innerJoin('chat.threads', 'chat.threads.id', 'chat.messages.threadId')
    .select((eb) => eb.fn.countAll<string>().as('rows'))
    .where('chat.threads.userId', '=', userId)
    .executeTakeFirstOrThrow();
  return {
    threads: await count('chat.threads'),
    messages: Number(messages.rows),
    usage: Number(usage.rows),
    facts: await count('memory.userFacts'),
    settings: await count('memory.userSettings'),
  };
}

describe('deleteLoadAccountData', () => {
  it('empties the load accounts and leaves every other user as it was', async () => {
    const loadAccount = await signUp('user-000000@load.invalid');
    const otherLoadAccount = await signUp('user-000001@load.invalid');
    const realUser = await signUp('someone@example.com');
    const lookalike = await signUp('user-000002@load.example.invalid');
    for (const userId of [loadAccount, otherLoadAccount, realUser, lookalike]) {
      await buildUp(userId);
    }
    const realBefore = await countsOf(realUser);
    const lookalikeBefore = await countsOf(lookalike);

    const deleted = await deleteLoadAccountData();

    expect(deleted).toEqual({ threads: 2, facts: 2, settings: 2 });
    for (const userId of [loadAccount, otherLoadAccount]) {
      expect(await countsOf(userId)).toEqual({
        threads: 0,
        messages: 0,
        usage: 0,
        facts: 0,
        settings: 0,
      });
    }
    expect(await countsOf(realUser)).toEqual(realBefore);
    expect(await countsOf(lookalike)).toEqual(lookalikeBefore);
    expect(realBefore.usage).toBe(1);
  });

  it('keeps the load accounts themselves', async () => {
    const loadAccount = await signUp('user-000000@load.invalid');
    await buildUp(loadAccount);

    await deleteLoadAccountData();

    const account = await db
      .selectFrom('auth.emailpasswordUsers')
      .select('email')
      .where('email', '=', 'user-000000@load.invalid')
      .executeTakeFirst();
    const user = await db
      .selectFrom('chat.users')
      .select('id')
      .where('id', '=', loadAccount)
      .executeTakeFirst();
    expect(account).toBeDefined();
    expect(user).toBeDefined();
  });
});

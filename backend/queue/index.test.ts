import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { env } from '@config/env';
import { db } from '@db/db';
import { insertMessage } from '@queries/messages/insertMessage';
import { findJobByKey } from '@queries/queue/findJobByKey';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { QUEUE_SCHEMA, startQueue, stopQueue } from '@queue/index';
import {
  THREAD_GENERATE_TITLE,
  enqueueThreadGenerateTitle,
} from '@queue/tasks/threadGenerateTitleTask';
import { useRecordedJobCommits } from '@test/jobCommits';
import { memoryOff } from '@test/memory';
import { useTestDb } from '@test/test-db';
import { run } from 'graphile-worker';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

const savedMockBaseUrl = process.env.MOCK_AI_BASE_URL;

afterEach(async () => {
  await stopQueue();
  process.env.MOCK_AI_BASE_URL = savedMockBaseUrl ?? '';
});

useTestDb();
const commitSettingsOf = useRecordedJobCommits();

/** Canned `chat.completion` endpoint answering every request with the title. */
async function startProvider(title: string) {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: title }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as { port: number };
  process.env.MOCK_AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

async function until(condition: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('startQueue', () => {
  it('fetches and finishes jobs without waiting for the flush', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const { id: threadId } = await insertThread({ userId });
    await insertMessage({ threadId, role: 'user', content: 'How do steam engines work?' });
    await insertMessage({ threadId, role: 'assistant', content: 'Steam pushes a piston.' });
    const stopProvider = await startProvider('Steam Engine Basics');
    try {
      await startQueue({ memory: memoryOff, threadAnalysisMode: 'heuristic' });
      await enqueueThreadGenerateTitle({ userId, threadId, forced: false });
      await until(
        async () => (await findThreadByIdAndUser({ userId, threadId }))?.title !== null,
        'the queue titles the thread',
      );
      await until(
        async () => (await findJobByKey({ task: THREAD_GENERATE_TITLE, key: threadId })) === null,
        'the finished job leaves the queue',
      );

      const fetches = await commitSettingsOf({ operation: 'UPDATE', task: THREAD_GENERATE_TITLE });
      expect(fetches.length).toBeGreaterThan(0);
      expect(new Set(fetches)).toEqual(new Set(['off']));
      expect(await commitSettingsOf({ operation: 'DELETE', task: THREAD_GENERATE_TITLE })).toEqual([
        'off',
      ]);
    } finally {
      await stopProvider();
    }
  });

  it('finishes a job that a crashed process left half done', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const { id: threadId } = await insertThread({ userId });
    await insertMessage({ threadId, role: 'user', content: 'How do steam engines work?' });
    await insertMessage({ threadId, role: 'assistant', content: 'Steam pushes a piston.' });
    await enqueueThreadGenerateTitle({ userId, threadId, forced: false });

    // A process that takes the job and never finishes it: the crash.
    let crash: (error: Error) => void = () => {};
    const crashed = await run({
      connectionString: env.DATABASE_URL,
      schema: QUEUE_SCHEMA,
      concurrency: 1,
      noHandleSignals: true,
      taskList: {
        [THREAD_GENERATE_TITLE]: () =>
          new Promise<void>((_resolve, reject) => {
            crash = reject;
          }),
      },
    });
    const stopProvider = await startProvider('Steam Engine Basics');
    try {
      await until(
        async () =>
          (await findJobByKey({ task: THREAD_GENERATE_TITLE, key: threadId }))?.state === 'running',
        'the crashed process holds the job',
      );
      // It took the job long ago.
      await sql`update queues._private_jobs set locked_at = now() - interval '1 hour'`.execute(db);

      await startQueue({ memory: memoryOff, threadAnalysisMode: 'heuristic' });

      await until(
        async () =>
          (await findThreadByIdAndUser({ userId, threadId }))?.title === 'Steam Engine Basics',
        'the restarted queue titles the thread',
      );
      // Finished jobs leave the queue in batches, so this one leaves a moment later.
      await until(
        async () => (await findJobByKey({ task: THREAD_GENERATE_TITLE, key: threadId })) === null,
        'the finished job leaves the queue',
      );
    } finally {
      crash(new Error('the process is gone'));
      await crashed.stop();
      await stopProvider();
    }
  });

  it('stops the queue it installs from notifying workers of new jobs', async () => {
    // A queue function that notifies, as an upgrade of the queue's schema would leave it.
    const probe = sql.id(QUEUE_SCHEMA, 'notifying_probe');
    await sql`create function ${probe}() returns void language plpgsql as $$
      begin
        perform pg_notify('jobs:insert', '{}');
      end $$`.execute(db);
    const notifies = async () => {
      const { rows } = await sql<{ notifies: boolean }>`
        select prosrc like '%pg_notify%' as notifies from pg_proc
        where oid = ${`${QUEUE_SCHEMA}.notifying_probe()`}::regprocedure`.execute(db);
      return rows[0]?.notifies;
    };
    try {
      expect(await notifies()).toBe(true);

      await startQueue({ memory: memoryOff, threadAnalysisMode: 'heuristic' });

      expect(await notifies()).toBe(false);
    } finally {
      await sql`drop function if exists ${probe}()`.execute(db);
    }
  });
});

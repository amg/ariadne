import { promises as fs, existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { startMockInferenceServer } from '../mock/inferenceServer';

/**
 * End-to-end smoke run: real HTTP + real Postgres + mock inference server.
 * Usage: `npm run smoke` (backend workspace).
 *
 * Mirrors the test-db resolution from test/global-setup.ts but against a
 * dedicated `chatbot_smoke` database — dev data is never touched.
 */

const SMOKE_DB_NAME = 'chatbot_smoke';
const FALLBACK_USER = 'postgres';
const FALLBACK_PASSWORD = 'postgrespassword';
const FALLBACK_PORT = 5432;

function detectGatewayIp(): string | undefined {
  try {
    for (const line of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const [, destination, gateway] = line.trim().split(/\s+/);
      if (destination === '00000000' && gateway && gateway !== '00000000') {
        const bytes = Buffer.from(gateway, 'hex');
        return `${bytes[3]}.${bytes[2]}.${bytes[1]}.${bytes[0]}`;
      }
    }
  } catch {
    // Not on Linux or /proc unavailable
  }
  return undefined;
}

async function ensureSmokeDatabase(): Promise<string> {
  const gateway = detectGatewayIp();
  if (!gateway) throw new Error('No gateway found — run this on a machine with Docker access.');
  const adminUrl = `postgres://${FALLBACK_USER}:${FALLBACK_PASSWORD}@${gateway}:${FALLBACK_PORT}/postgres`;
  const pool = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 3_000 });
  try {
    await pool.query(`drop database if exists ${JSON.stringify(SMOKE_DB_NAME)}`);
    await pool.query(`create database ${JSON.stringify(SMOKE_DB_NAME)}`);
  } finally {
    await pool.end();
  }
  return `postgres://${FALLBACK_USER}:${FALLBACK_PASSWORD}@${gateway}:${FALLBACK_PORT}/${SMOKE_DB_NAME}`;
}

function log(label: string, value: unknown) {
  console.log(`[smoke] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

/** Fetches and prints the thread's messages; returns the rows for assertions. */
async function logMessages(base: string, threadId: string, label: string) {
  const rows = (await (await fetch(`${base}/api/threads/${threadId}/messages`)).json()) as Array<{
    role: string;
    content: string;
    usage: unknown;
  }>;
  for (const message of rows) {
    log(`${label} ${message.role}`, { content: message.content, usage: message.usage });
  }
  return rows;
}

/**
 * Abort flow: start a PAUSE stream, wait for the first text chunk, abort,
 * then verify terminal state (no usage row; partial or empty content — both
 * correct over real HTTP).
 */
async function testInterruption(base: string, threadId: string) {
  const abortController = new AbortController();
  const interruptChat = await fetch(`${base}/api/threads/${threadId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { id: 'u-2', role: 'user', parts: [{ type: 'text', text: 'stop me PAUSE:2000' }] },
      ],
    }),
    signal: abortController.signal,
  });

  const sseReader = interruptChat.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (sseReader) {
    try {
      // The very first `data:` is only the message preamble — wait for text.
      for (;;) {
        const { value, done } = await sseReader.read();
        if (done || value?.includes('"Mock ')) break;
      }
    } catch {
      // Stream closed early.
    }
  }
  abortController.abort();
  // Let the server-side abort pipeline (persist partial text) settle.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const rows = await logMessages(base, threadId, 'after-interrupt');
  const interruptedAssistant = rows.find(
    (message) =>
      message.role === 'assistant' &&
      message.usage === null &&
      message.content !== 'Mock reply to: Hello world',
  );
  if (!interruptedAssistant) throw new Error('interrupted assistant row missing');
}

/**
 * In-flight guard: while a PAUSE exchange holds the thread on an open
 * connection, a second submit is bounced with 409; once that connection
 * closes the exchange settles interrupted and the thread retries cleanly.
 */
async function testInFlightGuard(base: string, threadId: string) {
  const running = await fetch(`${base}/api/threads/${threadId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { id: 'u-3', role: 'user', parts: [{ type: 'text', text: 'hold still PAUSE:3000' }] },
      ],
    }),
  });
  if (!running.ok) throw new Error(`running exchange failed: ${running.status}`);
  const sseReader = running.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (sseReader) {
    try {
      for (;;) {
        const { value, done } = await sseReader.read();
        if (done || value?.includes('"Mock ')) break;
      }
    } catch {
      // Stream closed early.
    }
  }

  const second = await fetch(`${base}/api/threads/${threadId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ id: 'u-4', role: 'user', parts: [{ type: 'text', text: 'second send' }] }],
    }),
  });
  log('second submit status', String(second.status));
  if (second.status !== 409) throw new Error(`expected 409, got ${second.status}`);
  log('second submit body', await second.json());

  // Closing the connection aborts the running exchange (the deliberate
  // tab-close kill surface); the thread must be released again afterwards.
  await sseReader?.cancel();
  await new Promise((resolve) => setTimeout(resolve, 500));

  const retry = await fetch(`${base}/api/threads/${threadId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trigger: 'regenerate-message', messages: [] }),
  });
  log('retry after close status', String(retry.status));
  if (!retry.ok) throw new Error(`retry failed: ${retry.status}`);
  await retry.text();

  const rows = await logMessages(base, threadId, 'after-guard');
  const recovered = rows.filter((message) => message.role === 'assistant').pop();
  if (!recovered || recovered.usage === null) {
    throw new Error('recovered exchange has no usage row');
  }
}

async function main() {
  // 1. Provision DB and configure env before importing anything that pools.
  process.env.DATABASE_URL = await ensureSmokeDatabase();
  const mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
  process.env.DEFAULT_MODEL = 'Qwen/Qwen3.5-9B';

  // 2. Fresh schema + migrations (import db module after env is set — it
  //    pools at import time).
  const { createDbFromPool } = await import('@db/db');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = createDbFromPool(pool);
  await sql`drop schema if exists public cascade`.execute(db);
  await sql`create schema public`.execute(db);
  const migrationsFolder = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/db/migrations',
  );
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: migrationsFolder }),
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;
  await db.destroy();

  // 3. Build the API in-process.
  const Fastify = (await import('fastify')).default;
  const { default: cors } = await import('@fastify/cors');
  const { setupChatPostRoute } = await import('../app/routes/chat');
  const { setupMessagesGetRoute } = await import('../app/routes/messages');
  const {
    setupThreadsDeleteRoute,
    setupThreadsGetRoute,
    setupThreadsPatchRoute,
    setupThreadsPostRoute,
  } = await import('../app/routes/threads');
  const { seedDefaultUser } = await import('../src/services/userService');

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  setupThreadsGetRoute(app);
  setupThreadsPostRoute(app);
  setupThreadsPatchRoute(app);
  setupThreadsDeleteRoute(app);
  setupMessagesGetRoute(app);
  setupChatPostRoute(app);
  await seedDefaultUser();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  const base = `http://127.0.0.1:${port}`;
  log('api', base);

  // 4. Create a thread and chat (useChat body shape).
  const threadRes = await fetch(`${base}/api/threads`, { method: 'POST' });
  log('create thread status', String(threadRes.status));
  const thread = (await threadRes.json()) as { id: string };
  log('thread', thread.id ?? JSON.stringify(thread));

  const chatRes = await fetch(`${base}/api/threads/${thread.id}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'Hello world' }] }],
    }),
  });
  if (!chatRes.ok) throw new Error(`chat failed: ${chatRes.status}`);
  log('chat content-type', chatRes.headers.get('content-type'));
  const sseText = await chatRes.text();
  log('sse events', sseText.split('\n').length);

  // 5. Verify the persisted states and usage telemetry.
  await logMessages(base, thread.id, 'message');

  // 6. Interruption flow: abort mid-stream and verify persisted partial text.
  await testInterruption(base, thread.id);

  // 7. Concurrency guard: a running exchange bounces a second submit, and
  //    the thread recovers once the running connection closes.
  await testInFlightGuard(base, thread.id);

  await app.close();
  await mock.stop();
  log('exit', 'ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

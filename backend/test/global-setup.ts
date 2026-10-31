// Entry point: load the repo-root .env before deriving the test DB URL
// (tests run against chatbot_test next to the database configured there).
import '@config/dotenv';
import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbFromPool } from '@db/db';
import { QUEUE_SCHEMA } from '@queue/index';
import { runMigrations } from 'graphile-worker';
import { sql } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool, escapeIdentifier } from 'pg';
import type { TestProject } from 'vitest/node';
import { findTestRedis } from './redis';
import { TEMPLATE_DB_URL_ENV, workerDatabaseName } from './worker-db';

/**
 * Database resolution order (always the dedicated `chatbot_test`
 * database — dev data is never touched):
 *   1. `TEST_DATABASE_URL` env var — explicit, always wins; the database
 *      must already exist at that URL.
 *   2. The database configured in the repo-root .env (`DATABASE_URL`, or
 *      the `DB_*` parts): `chatbot_test` is auto-provisioned on that
 *      server. This is the default `npm run gate` path on the host.
 *   3. Sandbox fallback: the same configured port and credentials, but
 *      reached via this container's default gateway — the route from the
 *      agent container to the host's docker-published database.
 *
 * The resolved database is migrated once and then serves as the template
 * for one clone per worker (`<name>_w1`…`<name>_wN`, same server), so the
 * credentials need CREATEDB in every mode.
 */
const TEST_DATABASE_URL_ENV = 'TEST_DATABASE_URL';

const TEST_DB_NAME = 'chatbot_test';
const FALLBACK_USER = 'postgres';
const FALLBACK_PASSWORD = 'postgrespassword'; // dev-only fallback credentials
const FALLBACK_PORT = 5432;

interface DbConfig {
  host: string | undefined;
  port: number;
  user: string;
  password: string;
}

/**
 * Connection details of the database this repo has configured:
 * `DATABASE_URL` wins, otherwise the `DB_*` parts; the dev-only
 * fallbacks apply when nothing is configured at all. `host` stays
 * undefined for bare `DB_*` parts with no `DB_HOST`.
 */
function deriveConfiguredDb() {
  const explicit = process.env.DATABASE_URL;
  if (explicit) {
    const url = new URL(explicit);
    return {
      host: url.hostname || undefined,
      port: Number(url.port || FALLBACK_PORT),
      user: decodeURIComponent(url.username) || FALLBACK_USER,
      password: decodeURIComponent(url.password) || FALLBACK_PASSWORD,
    };
  }
  return {
    host: process.env.DB_HOST || undefined,
    port: Number(process.env.DB_PORT ?? FALLBACK_PORT),
    user: process.env.DB_USER || FALLBACK_USER,
    password: process.env.DB_PASSWORD || FALLBACK_PASSWORD,
  };
}

/** Default-route gateway IP of this container's network (Linux only). */
function detectGatewayIp() {
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

/**
 * Ensure the dedicated `chatbot_test` database exists on the target
 * server and return its URL. Throws when no Postgres is reachable.
 */
async function ensureTestDatabase(target: { host: string } & DbConfig, timeoutMillis: number) {
  const admin = `postgres://${encodeURIComponent(target.user)}:${encodeURIComponent(target.password)}@${target.host}:${target.port}`;
  const pool = new Pool({
    connectionString: `${admin}/postgres`,
    connectionTimeoutMillis: timeoutMillis,
  });
  try {
    const existing = await pool.query('select 1 from pg_database where datname = $1', [
      TEST_DB_NAME,
    ]);
    if (existing.rowCount === 0) {
      // Constant identifier, not user input — safe without parameterisation
      // (CREATE DATABASE cannot be parameterised).
      await pool.query(`create database ${TEST_DB_NAME}`);
      console.log(`[test-db] created database "${TEST_DB_NAME}"`);
    }
  } finally {
    await pool.end();
  }
  return `${admin}/${TEST_DB_NAME}`;
}

/**
 * Probe the configured host first, then the same server through the
 * container gateway; both share the configured port and credentials.
 * Returns the first reachable candidate with its provenance.
 */
async function resolveSandboxDatabase() {
  const config = deriveConfiguredDb();
  const gateway = detectGatewayIp();

  const candidates: { host: string; mode: string }[] = [];
  if (config.host) {
    candidates.push({
      host: config.host,
      mode: `configured database at ${config.host}:${config.port}`,
    });
  }
  if (gateway && gateway !== config.host) {
    candidates.push({
      host: gateway,
      mode: `sandbox fallback via gateway ${gateway}:${config.port}`,
    });
  }
  if (candidates.length === 0) {
    throw new Error(
      `No database configured in .env and no network gateway found. Set ${TEST_DATABASE_URL_ENV} to a real Postgres URL.`,
    );
  }

  const tried: string[] = [];
  for (const candidate of candidates) {
    try {
      const url = await ensureTestDatabase({ ...config, host: candidate.host }, 3_000);
      return { url, mode: candidate.mode };
    } catch (error) {
      tried.push(`${candidate.host}:${config.port} (${String(error).split('\n')[0]})`);
    }
  }
  throw new Error(
    `No reachable Postgres: tried ${tried.join(', then ')} ` +
      `(started the docker compose db?). Set ${TEST_DATABASE_URL_ENV} explicitly.`,
  );
}

function redactUrl(url: string) {
  return url.replace(/:[^:@/]+@/, ':***@');
}

/**
 * Recreate `<template>_w1`…`<template>_wN` as copies of the migrated
 * template. The template must have no open connections while copying.
 * Each copy commits durably by default, as production does, even on a
 * server started with that turned off for speed.
 */
async function cloneWorkerDatabases(templateUrl: string, workers: number) {
  const url = new URL(templateUrl);
  const templateName = decodeURIComponent(url.pathname.slice(1));
  url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    for (let poolId = 1; poolId <= workers; poolId++) {
      const clone = escapeIdentifier(workerDatabaseName(templateName, poolId));
      await admin.query(`drop database if exists ${clone} with (force)`);
      await admin.query(`create database ${clone} template ${escapeIdentifier(templateName)}`);
      await admin.query(`alter database ${clone} set synchronous_commit = on`);
    }
  } finally {
    await admin.end();
  }
}

export default async function globalSetup(project: TestProject): Promise<void> {
  let databaseUrl = process.env[TEST_DATABASE_URL_ENV];
  let mode = `explicit ${TEST_DATABASE_URL_ENV}`;

  if (!databaseUrl) {
    const resolved = await resolveSandboxDatabase();
    databaseUrl = resolved.url;
    mode = resolved.mode;
  }

  console.log(`[test-db] ${mode}: ${redactUrl(databaseUrl)}`);

  // Fresh, deterministic schemas on every run, then run migrations: the
  // app's own, and the queue's, which its engine installs itself. The
  // domain schemas are dropped alongside `public`.
  const pool = new Pool({ connectionString: databaseUrl });
  const db = createDbFromPool(pool);
  try {
    const domainSchemas = ['chat', 'analysis', 'memory', 'billing'];
    for (const schema of [...domainSchemas, QUEUE_SCHEMA]) {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    }
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
    const { error, results } = await migrator.migrateToLatest();
    if (error) throw error;
    console.log(`[test-db] applied ${results?.length ?? 0} migrations`);
    await runMigrations({ connectionString: databaseUrl, schema: QUEUE_SCHEMA });
    console.log(`[test-db] installed the "${QUEUE_SCHEMA}" queue schema`);
  } finally {
    await db.destroy();
  }

  const workers = project.config.maxWorkers;
  await cloneWorkerDatabases(databaseUrl, workers);
  console.log(`[test-db] cloned ${workers} worker database(s)`);

  // Workers are spawned after setup and inherit this env.
  process.env[TEMPLATE_DB_URL_ENV] = databaseUrl;

  // Redis sits next to the database, or on this machine.
  const databaseHost = new URL(databaseUrl).hostname;
  await findTestRedis(
    [...new Set([databaseHost, '127.0.0.1', detectGatewayIp() ?? ''])].filter(Boolean),
  );
}

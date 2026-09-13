import { promises as fs, existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbFromPool } from '@db/db';
import { type Kysely, sql } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * Database resolution order:
 *   1. `TEST_DATABASE_URL` env var — explicit, always wins.
 *   2. A disposable testcontainers Postgres (same image as prod) when a
 *      Docker environment is available (typical dev host / CI).
 *   3. Sandbox fallback: reuse the dev `chat_db` Postgres published on the
 *      Docker host, reached via this container's default gateway. Uses a
 *      dedicated `chatbot_test` database only — dev data is never touched.
 */
const TEST_DATABASE_URL_ENV = 'TEST_DATABASE_URL';
const DB_URL_ENV = 'VITEST_TEST_DATABASE_URL';

const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';
const TEST_DB_NAME = 'chatbot_test';
const FALLBACK_USER = 'postgres';
const FALLBACK_PASSWORD = 'postgrespassword'; // dev-only credentials (docker-compose.yml)
const FALLBACK_PORT = 5432;

async function startPostgresContainer(): Promise<StartedTestContainer> {
  return new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_USER: FALLBACK_USER,
      POSTGRES_PASSWORD: FALLBACK_PASSWORD,
      POSTGRES_DB: TEST_DB_NAME,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
    .start();
}

function dockerLikelyAvailable(): boolean {
  return Boolean(
    process.env.DOCKER_HOST ||
      process.env.TESTCONTAINERS_HOST_OVERRIDE ||
      existsSync('/var/run/docker.sock'),
  );
}

/** Default-route gateway IP of this container's network (Linux only). */
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

/**
 * Ensure the dedicated `chatbot_test` database exists next to the dev
 * database and return its URL. Throws when no Postgres is reachable.
 */
async function ensureSandboxDatabase(gateway: string): Promise<string> {
  const adminUrl = `postgres://${FALLBACK_USER}:${FALLBACK_PASSWORD}@${gateway}:${FALLBACK_PORT}/postgres`;
  const pool = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 3_000 });
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
  } catch (error) {
    throw new Error(
      `No Docker environment and no reachable Postgres at ${gateway}:${FALLBACK_PORT} ` +
        `(started docker compose db? or set ${TEST_DATABASE_URL_ENV}). ` +
        `Original error: ${String(error)}`,
    );
  } finally {
    await pool.end();
  }
  return `postgres://${FALLBACK_USER}:${FALLBACK_PASSWORD}@${gateway}:${FALLBACK_PORT}/${TEST_DB_NAME}`;
}

function redactUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ':***@');
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  let container: StartedTestContainer | undefined;
  let databaseUrl = process.env[TEST_DATABASE_URL_ENV];
  let mode = `explicit ${TEST_DATABASE_URL_ENV}`;

  if (!databaseUrl && dockerLikelyAvailable()) {
    container = await startPostgresContainer();
    databaseUrl = `postgres://${FALLBACK_USER}:${FALLBACK_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${TEST_DB_NAME}`;
    mode = 'testcontainers';
  }

  if (!databaseUrl) {
    const gateway = detectGatewayIp();
    if (!gateway) {
      throw new Error(
        `No Docker environment found and no network gateway to fall back to. Start Docker or set ${TEST_DATABASE_URL_ENV} to a real Postgres URL.`,
      );
    }
    databaseUrl = await ensureSandboxDatabase(gateway);
    mode = `sandbox fallback via gateway ${gateway}`;
  }

  // Make the URL available to all test workers (they are spawned after setup).
  process.env[DB_URL_ENV] = databaseUrl;
  console.log(`[test-db] ${mode}: ${redactUrl(databaseUrl)}`);

  // Fresh, deterministic schema on every run, then run migrations.
  const pool = new Pool({ connectionString: databaseUrl });
  const db = createDbFromPool(pool);
  try {
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
  } finally {
    await db.destroy();
  }

  return async () => {
    await container?.stop();
  };
}

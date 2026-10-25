import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { db } from '@db/db';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * The row types in `schema.generated.ts` come from the migrated database
 * and the column overrides in `.kysely-codegenrc.json`. A failure here
 * means the file needs `npm run migrate && npm run db:types`, or an
 * override needs fixing. Three things leave the types wrong without any
 * other test failing: a migration the file does not yet reflect, an
 * override that names a column which no longer exists (the generator
 * ignores it), an override that states a nullability or default the
 * column does not have, and a table in a new schema that the generator is
 * not told to read.
 */

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const generatorConfig = z.object({
  overrides: z.object({ columns: z.record(z.string(), z.string()) }),
});

/** Schemas whose tables other systems create, so the generator leaves them out. */
const FOREIGN_SCHEMAS = ['public', 'queues', 'auth'];

async function readOverrides() {
  const config = generatorConfig.parse(
    JSON.parse(await readFile(path.join(backendRoot, '.kysely-codegenrc.json'), 'utf8')),
  );
  return config.overrides.columns;
}

describe('generated database types', () => {
  it('match the schema the migrations build', async () => {
    const databaseUrl = process.env.VITEST_TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error('expected the vitest worker database environment');

    await expect(
      promisify(execFile)(
        'npx',
        ['--no-install', 'kysely-codegen', '--verify', '--url', databaseUrl],
        { cwd: backendRoot },
      ),
    ).resolves.toBeDefined();
  }, 60_000);

  it('have no column override that names a missing column', async () => {
    const tables = await db.introspection.getTables();
    const columnKeys = tables.flatMap((table) =>
      table.columns.map((column) => `${table.schema}.${table.name}.${column.name}`),
    );

    const missing = Object.keys(await readOverrides()).filter((key) => !columnKeys.includes(key));

    expect(missing).toEqual([]);
  });

  it('have no column override that disagrees with the column on null or default', async () => {
    const tables = await db.introspection.getTables();
    const columns = new Map(
      tables.flatMap((table) =>
        table.columns.map((column) => [`${table.schema}.${table.name}.${column.name}`, column]),
      ),
    );

    const disagreeing = Object.entries(await readOverrides()).flatMap(([key, type]) => {
      const column = columns.get(key);
      if (!column) return [];
      const nullable = type.endsWith('| null');
      const defaulted = type.startsWith('Generated<') || type.includes('| undefined');
      return nullable === column.isNullable && defaulted === column.hasDefaultValue ? [] : [key];
    });

    expect(disagreeing).toEqual([]);
  });

  it('cover every schema the migrations create', async () => {
    const generated = await readFile(path.join(backendRoot, 'src/db/schema.generated.ts'), 'utf8');
    const generatedSchemas = new Set(
      [...generated.matchAll(/^ {2}"(\w+)\./gm)].flatMap((match) => (match[1] ? [match[1]] : [])),
    );
    const tables = await db.introspection.getTables();

    const left = tables
      .flatMap((table) => table.schema ?? [])
      .filter((schema) => !FOREIGN_SCHEMAS.includes(schema) && !generatedSchemas.has(schema));

    expect(left).toEqual([]);
  });
});

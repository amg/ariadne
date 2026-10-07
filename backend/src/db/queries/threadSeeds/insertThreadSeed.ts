import { db } from '@db/db';
import type { SeedLine, ThreadSeed } from '@db/types';
import { sql } from 'kysely';

type InsertThreadSeedProps = {
  threadId: string;
  lines: SeedLine[];
  factCount: number;
  handoverMessageId: string | null;
};

/** Freezes a Thread's Seed; a Thread carries at most one. */
export async function insertThreadSeed({
  lines,
  ...row
}: InsertThreadSeedProps): Promise<ThreadSeed> {
  return db
    .insertInto('memory.threadSeeds')
    .values({ ...row, lines: seedLinesJson(lines) })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * A jsonb value for the `lines` column. The pg driver would send a JS array
 * as a Postgres array, so the lines go over as JSON text and are cast.
 */
export function seedLinesJson(lines: SeedLine[]) {
  return sql<SeedLine[]>`${JSON.stringify(lines)}::jsonb`;
}

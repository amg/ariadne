import type { Kysely } from 'kysely';

interface MigrationSchema {
  threads: {
    title: string | null;
  };
}

export async function up(db: Kysely<unknown>) {
  await db.schema
    .alterTable('threads')
    .alterColumn('title', (col) => col.dropNotNull())
    .execute();
}

export async function down(db: Kysely<MigrationSchema>) {
  // Update any existing nulls to the fallback before restoring NOT NULL
  await db.updateTable('threads').set({ title: 'New Chat' }).where('title', 'is', null).execute();

  await db.schema
    .alterTable('threads')
    .alterColumn('title', (col) => col.setNotNull())
    .execute();
}

import type { Database, User } from '@db/types';
import type { Kysely } from 'kysely';

export async function findUserById(db: Kysely<Database>, id: string): Promise<User | undefined> {
  return db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
}

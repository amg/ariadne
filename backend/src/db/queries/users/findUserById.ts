import { db } from '@db/db';
import type { User } from '@db/types';

export async function findUserById(id: string): Promise<User | undefined> {
  return db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
}

import { db } from '@db/db';
import type { User } from '@db/types';

type FindUserByIdProps = {
  id: string;
};

export async function findUserById({ id }: FindUserByIdProps): Promise<User | undefined> {
  return db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
}

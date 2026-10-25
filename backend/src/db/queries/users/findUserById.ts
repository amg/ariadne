import { db } from '@db/db';

type FindUserByIdProps = {
  id: string;
};

export async function findUserById({ id }: FindUserByIdProps) {
  return db.selectFrom('chat.users').selectAll().where('id', '=', id).executeTakeFirst();
}

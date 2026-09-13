import { db } from '@db/db';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000000';

export async function seedDefaultUser(): Promise<void> {
  const user = await db.selectFrom('users').where('id', '=', DEFAULT_USER_ID).executeTakeFirst();
  if (!user) {
    await db.insertInto('users').values({ id: DEFAULT_USER_ID }).execute();
    console.log('Seeded default user');
  }
}

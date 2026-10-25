import { db } from '@db/db';

type FindModelConfigByModelIdProps = {
  modelId: string;
};

/** Fetches a single model config row by its primary key. */
export async function findModelConfigByModelId({ modelId }: FindModelConfigByModelIdProps) {
  return db
    .selectFrom('billing.modelConfigs')
    .selectAll()
    .where('modelId', '=', modelId)
    .executeTakeFirst();
}

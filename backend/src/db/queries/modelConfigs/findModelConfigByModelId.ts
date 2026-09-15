import { db } from '@db/db';
import type { ModelConfig } from '@db/types';

type FindModelConfigByModelIdProps = {
  modelId: string;
};

/** Fetches a single model config row by its primary key. */
export async function findModelConfigByModelId({
  modelId,
}: FindModelConfigByModelIdProps): Promise<ModelConfig | undefined> {
  return db
    .selectFrom('modelConfigs')
    .selectAll()
    .where('modelId', '=', modelId)
    .executeTakeFirst();
}

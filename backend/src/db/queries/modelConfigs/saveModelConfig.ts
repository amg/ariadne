import { db } from '@db/db';
import type { NewModelConfig } from '@db/types';

type SaveModelConfigProps = {
  config: NewModelConfig;
};

/**
 * Upserts a model config by primary key. On conflict the pricing/context
 * fields are refreshed; `provider` is left untouched (it is part of the
 * identity, not the cached data).
 */
export async function saveModelConfig({ config }: SaveModelConfigProps): Promise<void> {
  await db
    .insertInto('modelConfigs')
    .values(config)
    .onConflict((oc) =>
      oc.column('modelId').doUpdateSet({
        contextWindow: config.contextWindow,
        inputPricePerMillion: config.inputPricePerMillion,
        outputPricePerMillion: config.outputPricePerMillion,
        cachedRateMultiplier: config.cachedRateMultiplier,
        supportsCaching: config.supportsCaching,
        lastUpdated: config.lastUpdated,
      }),
    )
    .execute();
}

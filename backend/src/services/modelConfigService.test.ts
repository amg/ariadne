import { env } from '@config/env';
import { db } from '@db/db';
import type { NewModelConfig } from '@db/types';
import {
  getModelConfig,
  getTimeUntilNextRefresh,
  refreshModelConfigs,
} from '@services/modelConfigService';
import { useTestDb } from '@test/test-db';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * modelConfigService stays stateless: the refresh cooldown is derived from
 * `model_configs.last_updated` (shared DB), not a server-side global, so it
 * holds across servers and users.
 */

async function seedConfig(lastUpdated: Date) {
  const row: NewModelConfig = {
    modelId: 'test/model',
    provider: 'deepinfra',
    contextWindow: 1000,
    inputPricePerMillion: 1,
    outputPricePerMillion: 2,
    cachedRateMultiplier: 0.5,
    supportsCaching: true,
    lastUpdated,
  };
  await db.insertInto('billing.modelConfigs').values(row).execute();
}

describe('modelConfigService', () => {
  useTestDb();

  describe('refresh cooldown (shared via model_configs.last_updated)', () => {
    it('allows a refresh when no configs have been loaded yet', async () => {
      expect(await getTimeUntilNextRefresh()).toBe(0);
    });

    it('blocks refreshes within 1 minute of the newest row update', async () => {
      await seedConfig(new Date());

      const waitTime = await getTimeUntilNextRefresh();
      expect(waitTime).toBeGreaterThan(0);
      expect(waitTime).toBeLessThanOrEqual(60_000);
    });

    it('allows a refresh again once the newest row is older than 1 minute', async () => {
      await seedConfig(new Date(Date.now() - 2 * 60_000));

      expect(await getTimeUntilNextRefresh()).toBe(0);
    });

    it('refreshModelConfigs reports rateLimited without hitting the network during cooldown', async () => {
      await seedConfig(new Date());

      const result = await refreshModelConfigs();

      expect(result).toMatchObject({ success: true, modelsUpdated: 0, rateLimited: true });
    });
  });

  describe('single fallback source', () => {
    it('falls back to the hard-coded default model config when the DB has no row', async () => {
      const config = await getModelConfig(env.DEFAULT_MODEL);

      expect(config).toMatchObject({
        modelId: env.DEFAULT_MODEL,
        inputPricePerMillion: 0.1,
        outputPricePerMillion: 0.15,
        cachedRateMultiplier: 0.5,
        cachedPricePerMillion: 0.05,
        supportsCaching: true,
      });
    });

    it('prefers the DB row over the fallback', async () => {
      await seedConfig(new Date());

      const config = await getModelConfig('test/model');
      expect(config).toMatchObject({ inputPricePerMillion: 1, outputPricePerMillion: 2 });
    });

    it('returns null for unknown models with no DB row', async () => {
      expect(await getModelConfig('unknown/model')).toBeNull();
    });
  });

  describe('reading the model list the provider sends', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function providerAnswers(body: unknown) {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    }

    async function storedModelIds() {
      const rows = await db.selectFrom('billing.modelConfigs').select('modelId').execute();
      return rows.map((row) => row.modelId).sort();
    }

    it('fails the refresh, as for an error status, when the list is not a list', async () => {
      providerAnswers({ error: 'maintenance' });

      const result = await refreshModelConfigs();

      expect(result).toMatchObject({ success: false, modelsUpdated: 0 });
      expect(await storedModelIds()).toEqual([]);
    });

    it('stores the models it can read and skips the ones it cannot', async () => {
      providerAnswers([
        {
          name: 'org/readable',
          context_length: 4096,
          pricing: { cents_per_input_token: 0.00001, cents_per_output_token: 0.00002 },
        },
        'not a model',
        null,
        { name: 5 },
        { name: 'org/no-details', pricing: null, capabilities: null },
      ]);

      const result = await refreshModelConfigs();

      expect(result).toEqual({ success: true, modelsUpdated: 2 });
      expect(await storedModelIds()).toEqual(['org/no-details', 'org/readable']);
    });
  });
});

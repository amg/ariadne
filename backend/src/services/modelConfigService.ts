import { env } from '@config/env';
import type { NewModelConfig } from '@db/types';
import { findModelConfigByModelId } from '@queries/modelConfigs/findModelConfigByModelId';
import { getLatestModelConfigRefresh } from '@queries/modelConfigs/getLatestModelConfigRefresh';
import { saveModelConfig } from '@queries/modelConfigs/saveModelConfig';
import { z } from 'zod';

/**
 * The fields read from one model of DeepInfra's list (snake_case, as the
 * provider writes them). A model may omit any of them or send null, so every
 * field is optional.
 */
const deepInfraModelSchema = z.object({
  _id: z.string().nullish(),
  name: z.string().nullish(),
  model_name: z.string().nullish(),
  context_length: z.number().nullish(),
  pricing: z
    .object({
      cents_per_input_token: z.number().nullish(),
      cents_per_output_token: z.number().nullish(),
      rate_per_input_token_cached: z.number().nullish(),
    })
    .nullish(),
  capabilities: z.object({ caching: z.boolean().nullish() }).nullish(),
});

type DeepInfraModel = z.infer<typeof deepInfraModelSchema>;

/** Our model config row. */
interface ModelConfigRow {
  modelId: string;
  provider: string;
  contextWindow: number | null;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cachedPricePerMillion: number | null; // absolute price per million (inputPrice × cachedRateMultiplier)
  cachedRateMultiplier: number | null; // multiplier of input price (e.g., 0.5 = 50%)
  supportsCaching: boolean;
  lastUpdated: Date;
}

/** Fallback config for when API is unavailable. Keyed to the default model so
 *  it stays the natural answer for `getModelConfig(env.DEFAULT_MODEL)` no
 *  matter which model that points at. */
const FALLBACK_CONFIG: ModelConfigRow = {
  modelId: env.DEFAULT_MODEL,
  provider: 'deepinfra',
  contextWindow: 32768,
  inputPricePerMillion: 0.1,
  outputPricePerMillion: 0.15,
  cachedPricePerMillion: 0.05, // 50% of input price
  cachedRateMultiplier: 0.5, // 50% discount for cached tokens
  supportsCaching: true,
  lastUpdated: new Date(),
};

/**
 * Refresh cooldown state lives in the DB (`billing.model_configs.last_updated`),
 * not in server memory: services must stay stateless so any number of
 * servers enforces the same 1-minute floor (no per-process globals).
 *   - `last_updated` chosen over `created_at`: only updated on refresh
 *     upserts (rows are upserted by PK, `created` would never change).
 *   - Every refresh bumps `last_updated` on ALL upserted rows, so
 *     `max(last_updated)` is the shared "last refresh" marker.
 *   - Remaining race window: two requests can pass the check
 *     simultaneously during an in-flight refresh; upserts are idempotent,
 *     so a duplicate concurrent refresh is harmless.
 */
const REFRESH_COOLDOWN_MS = 60 * 1000; // 1 minute

/**
 * Gets time (ms) until the next refresh is allowed, shared across all
 * servers and users. Returns 0 if a refresh is allowed now (including
 * when no configs have been loaded yet).
 */
export async function getTimeUntilNextRefresh() {
  const latest = await getLatestModelConfigRefresh();

  const last = latest ? latest.getTime() : Number.NaN;
  if (Number.isNaN(last)) return 0;

  return Math.max(0, REFRESH_COOLDOWN_MS - (Date.now() - last));
}

/**
 * Fetches model list from DeepInfra API.
 * Returns the models it can read, or null when the fetch fails or the answer
 * is not a list. A model that does not fit the schema is skipped, so one odd
 * entry never costs the rest.
 */
async function fetchDeepInfraModels() {
  try {
    const res = await fetch('https://api.deepinfra.com/models/list', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      console.error(`DeepInfra API error: ${res.status} ${res.statusText}`);
      return null;
    }

    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
      console.error('DeepInfra API error: the model list is not a list');
      return null;
    }
    const models = data.flatMap((entry) => {
      const model = deepInfraModelSchema.safeParse(entry);
      return model.success ? [model.data] : [];
    });
    if (models.length < data.length) {
      console.error(
        `DeepInfra model list: skipped ${data.length - models.length} unreadable entries`,
      );
    }
    return models;
  } catch (error) {
    console.error('Failed to fetch DeepInfra models:', error);
    return null;
  }
}

/**
 * Parses a DeepInfra model into our config format.
 * DeepInfra returns:
 * - cents_per_input_token: price per token in cents
 * - cents_per_output_token: price per token in cents
 * - rate_per_input_token_cached: multiplier (e.g., 0.5 = 50% of input price)
 */
function parseDeepInfraModel(model: DeepInfraModel) {
  // DeepInfra's /models/list returns some objects that lack model_name or id,
  // or use `model_name` instead of `name`. We need to handle this robustly.
  const modelId = model.name ?? model.model_name ?? model._id;
  if (!modelId) return null;

  // Convert cents per token to USD per million tokens
  const inputPrice = model.pricing?.cents_per_input_token
    ? model.pricing.cents_per_input_token * 10_000 // cents/token * 10000 = USD/million
    : null;
  const outputPrice = model.pricing?.cents_per_output_token
    ? model.pricing.cents_per_output_token * 10_000
    : null;

  // rate_per_input_token_cached is a multiplier (e.g., 0.5 = 50% of input price)
  const cachedRateMultiplier = model.pricing?.rate_per_input_token_cached ?? null;
  // Calculate absolute cached price per million
  const cachedPrice =
    inputPrice !== null && cachedRateMultiplier !== null ? inputPrice * cachedRateMultiplier : null;

  return {
    modelId,
    provider: 'deepinfra',
    contextWindow: model.context_length ?? null,
    inputPricePerMillion: inputPrice,
    outputPricePerMillion: outputPrice,
    cachedPricePerMillion: cachedPrice,
    cachedRateMultiplier: cachedRateMultiplier,
    supportsCaching: model.capabilities?.caching ?? false,
    lastUpdated: new Date(),
  };
}

/**
 * Fetches models from DeepInfra and upserts them into DB.
 * Returns count of models updated.
 * Rate limited to once per minute.
 */
export async function refreshModelConfigs(): Promise<{
  success: boolean;
  modelsUpdated: number;
  error?: string;
  rateLimited?: boolean;
}> {
  // Rate limit shared via DB (stateless across servers/users).
  const waitTime = await getTimeUntilNextRefresh();
  if (waitTime > 0) {
    return {
      success: true, // We treat this as a successful no-op on the backend
      modelsUpdated: 0,
      rateLimited: true,
    };
  }

  const models = await fetchDeepInfraModels();
  if (!models) {
    return { success: false, modelsUpdated: 0, error: 'Failed to fetch from DeepInfra API' };
  }

  // One shared timestamp for the batch so max(last_updated) marks this refresh.
  const refreshedAt = new Date();
  const configs = models
    .map(parseDeepInfraModel)
    .filter((config): config is ModelConfigRow => config !== null);
  let updated = 0;

  for (const config of configs) {
    const row: NewModelConfig = {
      modelId: config.modelId,
      provider: config.provider,
      contextWindow: config.contextWindow,
      inputPricePerMillion: config.inputPricePerMillion,
      outputPricePerMillion: config.outputPricePerMillion,
      cachedRateMultiplier: config.cachedRateMultiplier,
      supportsCaching: config.supportsCaching,
      lastUpdated: refreshedAt,
    };

    await saveModelConfig({ config: row });
    updated++;
  }

  return { success: true, modelsUpdated: updated };
}

/** The pricing tier every unknown model falls back to. */
export function getFallbackPricing() {
  return {
    inputPerMillionUsd: FALLBACK_CONFIG.inputPricePerMillion ?? 0,
    outputPerMillionUsd: FALLBACK_CONFIG.outputPricePerMillion ?? 0,
  };
}

/**
 * Gets config for a specific model.
 * Falls back to hardcoded config if not in DB.
 */
export async function getModelConfig(modelId: string) {
  const config = await findModelConfigByModelId({ modelId });

  if (config) {
    // Calculate cachedPricePerMillion from cachedRateMultiplier
    const cachedPrice =
      config.inputPricePerMillion !== null && config.cachedRateMultiplier !== null
        ? config.inputPricePerMillion * config.cachedRateMultiplier
        : null;

    return {
      modelId: config.modelId,
      provider: config.provider,
      contextWindow: config.contextWindow,
      inputPricePerMillion: config.inputPricePerMillion,
      outputPricePerMillion: config.outputPricePerMillion,
      cachedPricePerMillion: cachedPrice,
      cachedRateMultiplier: config.cachedRateMultiplier,
      supportsCaching: config.supportsCaching,
      lastUpdated: config.lastUpdated,
    };
  }

  // Fallback to hardcoded config
  if (modelId === FALLBACK_CONFIG.modelId) {
    return FALLBACK_CONFIG;
  }

  return null;
}

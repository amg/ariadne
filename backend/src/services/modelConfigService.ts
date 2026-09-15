import { db } from '@db/db';
import type { NewModelConfig } from '@db/types';

/** Model config from DeepInfra API. */
interface DeepInfraModel {
  _id: string;
  name: string;
  organization: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    image?: string;
    cents_per_input_token?: number;
    cents_per_output_token?: number;
    rate_per_input_token_cached?: number;
  };
  modality?: {
    text?: boolean;
    image?: boolean;
  };
  capabilities?: {
    chat_completion?: boolean;
    caching?: boolean;
  };
}

/** Our model config row. */
export interface ModelConfigRow {
  model_id: string;
  provider: string;
  context_window: number | null;
  input_price_per_million: number | null;
  output_price_per_million: number | null;
  cached_price_per_million: number | null; // absolute price per million (input_price × cached_rate_multiplier)
  cached_rate_multiplier: number | null; // multiplier of input price (e.g., 0.5 = 50%)
  supports_caching: boolean;
  last_updated: Date;
}

/** Fallback config for when API is unavailable. */
const FALLBACK_CONFIG: ModelConfigRow = {
  model_id: 'Qwen/Qwen3.5-9B',
  provider: 'deepinfra',
  context_window: 32768,
  input_price_per_million: 0.1,
  output_price_per_million: 0.15,
  cached_price_per_million: 0.05, // 50% of input price
  cached_rate_multiplier: 0.5, // 50% discount for cached tokens
  supports_caching: true,
  last_updated: new Date(),
};

/** In-memory rate limit state. */
let lastRefreshTimestamp: number | null = null;
const REFRESH_COOLDOWN_MS = 60 * 1000; // 1 minute

/**
 * Checks if refresh is allowed based on rate limit.
 * Returns true if allowed, false if in cooldown.
 */
export function canRefreshModels(): boolean {
  if (lastRefreshTimestamp === null) return true;
  const now = Date.now();
  return now - lastRefreshTimestamp >= REFRESH_COOLDOWN_MS;
}

/**
 * Gets time until next refresh is allowed.
 * Returns 0 if refresh is allowed now.
 */
export function getTimeUntilNextRefresh(): number {
  if (lastRefreshTimestamp === null) return 0;
  const now = Date.now();
  const elapsed = now - lastRefreshTimestamp;
  return Math.max(0, REFRESH_COOLDOWN_MS - elapsed);
}

/**
 * Fetches model list from DeepInfra API.
 * Returns parsed models or null if fetch fails.
 */
export async function fetchDeepInfraModels(): Promise<DeepInfraModel[] | null> {
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

    const data = await res.json();
    return data as DeepInfraModel[];
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
function parseDeepInfraModel(model: DeepInfraModel): ModelConfigRow {
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
    model_id: model.name,
    provider: 'deepinfra',
    context_window: model.context_length ?? null,
    input_price_per_million: inputPrice,
    output_price_per_million: outputPrice,
    cached_price_per_million: cachedPrice,
    cached_rate_multiplier: cachedRateMultiplier,
    supports_caching: model.capabilities?.caching ?? false,
    last_updated: new Date(),
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
  // Check rate limit
  if (!canRefreshModels()) {
    const waitTime = getTimeUntilNextRefresh();
    return {
      success: false,
      modelsUpdated: 0,
      error: `Rate limited. Please wait ${Math.ceil(waitTime / 1000)} seconds.`,
      rateLimited: true,
    };
  }

  const models = await fetchDeepInfraModels();
  if (!models) {
    return { success: false, modelsUpdated: 0, error: 'Failed to fetch from DeepInfra API' };
  }

  const configs = models.map(parseDeepInfraModel);
  let updated = 0;

  for (const config of configs) {
    const row: NewModelConfig = {
      model_id: config.model_id,
      provider: config.provider,
      context_window: config.context_window,
      input_price_per_million: config.input_price_per_million,
      output_price_per_million: config.output_price_per_million,
      cached_rate_multiplier: config.cached_rate_multiplier,
      supports_caching: config.supports_caching,
    };

    await db
      .insertInto('model_configs')
      .values(row)
      .onConflict((oc) =>
        oc.column('model_id').doUpdateSet({
          context_window: config.context_window,
          input_price_per_million: config.input_price_per_million,
          output_price_per_million: config.output_price_per_million,
          cached_rate_multiplier: config.cached_rate_multiplier,
          supports_caching: config.supports_caching,
          last_updated: config.last_updated,
        }),
      )
      .execute();
    updated++;
  }

  // Update rate limit timestamp
  lastRefreshTimestamp = Date.now();

  return { success: true, modelsUpdated: updated };
}

/**
 * Gets config for a specific model.
 * Falls back to hardcoded config if not in DB.
 */
export async function getModelConfig(modelId: string): Promise<ModelConfigRow | null> {
  const config = await db
    .selectFrom('model_configs')
    .selectAll()
    .where('model_id', '=', modelId)
    .executeTakeFirst();

  if (config) {
    // Calculate cached_price_per_million from cached_rate_multiplier
    const cachedPrice =
      config.input_price_per_million !== null && config.cached_rate_multiplier !== null
        ? config.input_price_per_million * config.cached_rate_multiplier
        : null;

    return {
      model_id: config.model_id,
      provider: config.provider,
      context_window: config.context_window,
      input_price_per_million: config.input_price_per_million,
      output_price_per_million: config.output_price_per_million,
      cached_price_per_million: cachedPrice,
      cached_rate_multiplier: config.cached_rate_multiplier,
      supports_caching: config.supports_caching,
      last_updated: config.last_updated,
    };
  }

  // Fallback to hardcoded config
  if (modelId === FALLBACK_CONFIG.model_id) {
    return FALLBACK_CONFIG;
  }

  return null;
}

/**
 * Gets configs for multiple models.
 */
export async function getModelConfigs(modelIds: string[]): Promise<Record<string, ModelConfigRow>> {
  const configs = await db
    .selectFrom('model_configs')
    .selectAll()
    .where('model_id', 'in', modelIds)
    .execute();

  const result: Record<string, ModelConfigRow> = {};
  for (const config of configs) {
    const cachedPrice =
      config.input_price_per_million !== null && config.cached_rate_multiplier !== null
        ? config.input_price_per_million * config.cached_rate_multiplier
        : null;

    result[config.model_id] = {
      model_id: config.model_id,
      provider: config.provider,
      context_window: config.context_window,
      input_price_per_million: config.input_price_per_million,
      output_price_per_million: config.output_price_per_million,
      cached_price_per_million: cachedPrice,
      cached_rate_multiplier: config.cached_rate_multiplier,
      supports_caching: config.supports_caching,
      last_updated: config.last_updated,
    };
  }

  // Add fallback for known model
  if (modelIds.includes(FALLBACK_CONFIG.model_id) && !result[FALLBACK_CONFIG.model_id]) {
    result[FALLBACK_CONFIG.model_id] = FALLBACK_CONFIG;
  }

  return result;
}

/**
 * Lists all cached model configs.
 */
export async function listModelConfigs(): Promise<ModelConfigRow[]> {
  const configs = await db.selectFrom('model_configs').selectAll().orderBy('model_id').execute();

  return configs.map((config) => {
    const cachedPrice =
      config.input_price_per_million !== null && config.cached_rate_multiplier !== null
        ? config.input_price_per_million * config.cached_rate_multiplier
        : null;

    return {
      model_id: config.model_id,
      provider: config.provider,
      context_window: config.context_window,
      input_price_per_million: config.input_price_per_million,
      output_price_per_million: config.output_price_per_million,
      cached_price_per_million: cachedPrice,
      cached_rate_multiplier: config.cached_rate_multiplier,
      supports_caching: config.supports_caching,
      last_updated: config.last_updated,
    };
  });
}

/**
 * Deletes old/unused model configs (optional cleanup).
 */
export async function cleanupModelConfigs(keepModelIds: string[]): Promise<number> {
  const result = await db
    .deleteFrom('model_configs')
    .where('model_id', 'not in', keepModelIds)
    .execute();

  return result.length;
}

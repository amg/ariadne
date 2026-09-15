import { db } from '@db/db';
import type { NewModelConfig } from '@db/types';

/** Model config from DeepInfra API (external wire format — snake_case). */
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

/** Fallback config for when API is unavailable. */
const FALLBACK_CONFIG: ModelConfigRow = {
  modelId: 'Qwen/Qwen3.5-9B',
  provider: 'deepinfra',
  contextWindow: 32768,
  inputPricePerMillion: 0.1,
  outputPricePerMillion: 0.15,
  cachedPricePerMillion: 0.05, // 50% of input price
  cachedRateMultiplier: 0.5, // 50% discount for cached tokens
  supportsCaching: true,
  lastUpdated: new Date(),
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
    modelId: model.name,
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
      modelId: config.modelId,
      provider: config.provider,
      contextWindow: config.contextWindow,
      inputPricePerMillion: config.inputPricePerMillion,
      outputPricePerMillion: config.outputPricePerMillion,
      cachedRateMultiplier: config.cachedRateMultiplier,
      supportsCaching: config.supportsCaching,
    };

    await db
      .insertInto('modelConfigs')
      .values(row)
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
    .selectFrom('modelConfigs')
    .selectAll()
    .where('modelId', '=', modelId)
    .executeTakeFirst();

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

/**
 * Gets configs for multiple models.
 */
export async function getModelConfigs(modelIds: string[]): Promise<Record<string, ModelConfigRow>> {
  const configs = await db
    .selectFrom('modelConfigs')
    .selectAll()
    .where('modelId', 'in', modelIds)
    .execute();

  const result: Record<string, ModelConfigRow> = {};
  for (const config of configs) {
    const cachedPrice =
      config.inputPricePerMillion !== null && config.cachedRateMultiplier !== null
        ? config.inputPricePerMillion * config.cachedRateMultiplier
        : null;

    result[config.modelId] = {
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

  // Add fallback for known model
  if (modelIds.includes(FALLBACK_CONFIG.modelId) && !result[FALLBACK_CONFIG.modelId]) {
    result[FALLBACK_CONFIG.modelId] = FALLBACK_CONFIG;
  }

  return result;
}

/**
 * Lists all cached model configs.
 */
export async function listModelConfigs(): Promise<ModelConfigRow[]> {
  const configs = await db.selectFrom('modelConfigs').selectAll().orderBy('modelId').execute();

  return configs.map((config) => {
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
  });
}

/**
 * Deletes old/unused model configs (optional cleanup).
 */
export async function cleanupModelConfigs(keepModelIds: string[]): Promise<number> {
  const result = await db
    .deleteFrom('modelConfigs')
    .where('modelId', 'not in', keepModelIds)
    .execute();

  return result.length;
}

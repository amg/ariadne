/**
 * AI Connector service — public surface.
 * Folder layout: config.ts (provider/env), cost.ts (pure cost math —
 * pricing resolved via @services/modelConfigService),
 * usageMap.ts (usage → message_usage row),
 * exchange.ts (per-exchange lifecycle/persistence + idle watchdog), submitChat.ts (flow).
 */
export { DEFAULT_MODEL_ID } from './config';
export { computeCostUsd } from './cost';
export { retryLastExchange, submitChat, type ChatStreamHandle } from './submitChat';

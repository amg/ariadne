/**
 * AI Connector service — public surface.
 * Folder layout: config.ts (provider/env), cost.ts (pricing),
 * usageMap.ts (usage → message_usage row), idleGuard.ts (inter-token guard),
 * exchange.ts (per-exchange lifecycle/persistence), submitChat.ts (flow).
 */
export { DEFAULT_MODEL_ID } from './config';
export { computeCostUsd } from './cost';
export { submitChat, type ChatStreamHandle } from './submitChat';

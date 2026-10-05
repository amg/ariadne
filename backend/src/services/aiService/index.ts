/**
 * AI Connector service — public surface.
 * Folder layout: config.ts (provider/env), cost.ts (pure cost math —
 * pricing resolved via @services/modelConfigService),
 * usageMap.ts (usage → message_usage row), embedText.ts (embedding export
 * for thread-health window embeddings), rewrite.ts (the expanded-signal
 * decontextualising rewrite call), judge.ts (the expansion trigger's
 * context-clarity verdict call), extractFacts.ts and judgeFactDuplicate.ts
 * (the memory pipeline's extraction and duplicate-check calls),
 * exchange.ts (per-exchange lifecycle/persistence + idle watchdog), submitChat.ts (flow).
 */
export { computeCostUsd } from './cost';
export { computeEmbeddingCostUsd, computeInferenceCostUsd } from './pricing';
export { EMBEDDING_MODEL_ID } from './config';
export { embedText, type EmbedTextData } from './embedText';
export { rewriteFollowUp } from './rewrite';
export { extractFacts, type FactCandidate } from './extractFacts';
export { judgeFactDuplicate } from './judgeFactDuplicate';
export { countTextTokens } from './usageMap';
export {
  judgeContextDependence,
  type ContextDependenceVerdict,
  type JudgeContextDependenceInput,
} from './judge';
export {
  stopThreadExchange,
  registerActiveExchange,
  clearActiveExchange,
} from './exchangeRegistry';
export { pausedArrivalOrNull } from './pausedArrival';
export {
  isDriftPause,
  retryLastExchange,
  submitChat,
  type ChatStreamHandle,
  type DriftPause,
} from './submitChat';

/**
 * AI Connector service — public surface.
 * Folder layout: config.ts (provider/env), cost.ts (pure cost math —
 * pricing resolved via @services/modelConfigService),
 * usageMap.ts (usage → message_usage row), embedText.ts (embedding export
 * for thread-health window embeddings), rewrite.ts (the expanded-signal
 * decontextualising rewrite call), judge.ts (the expansion trigger's
 * context-clarity verdict call),
 * exchange.ts (per-exchange lifecycle/persistence + idle watchdog), submitChat.ts (flow).
 */
export { computeCostUsd } from './cost';
export { EMBEDDING_MODEL_ID, JUDGE_MODEL_ID, REWRITE_MODEL_ID } from './config';
export { embedText, type EmbedTextData } from './embedText';
export { rewriteFollowUp } from './rewrite';
export {
  judgeContextDependence,
  type ContextDependenceVerdict,
  type JudgeContextDependenceInput,
} from './judge';
export { retryLastExchange, submitChat, type ChatStreamHandle } from './submitChat';

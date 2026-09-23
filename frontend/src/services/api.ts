export type Role = 'user' | 'assistant' | 'system';
export type MessageFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'timeout'
  | 'interrupted';

/** The deployment feature-flag surfaces the chrome is driven from. */
export interface AppConfig {
  /** off|heuristic|always — `off` hides the Analysis tab and bubble tints. */
  threadAnalysisMode: 'off' | 'heuristic' | 'always';
}

export async function fetchConfig(): Promise<AppConfig> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`Failed to fetch config: ${res.statusText}`);
  return res.json();
}

export type ThreadAnalysisMode = AppConfig['threadAnalysisMode'];

/** Admin-level thread health flag (mirrors backend `THREAD_ANALYSIS_MODE`). */
export type DriftVerdict = 'muted' | 'pass' | 'fire';
export type DriftFireChannel = 'immediate' | 'slow';

/** The live gate's verdict on one arriving user message. */
export interface MessageDriftVerdict {
  verdict: DriftVerdict;
  fireChannel: DriftFireChannel | null;
}

// ── Analysis endpoint: the thread's live reading from persisted signals ──

export interface LiveAnalysisSegment {
  index: number;
  segmentId: string;
  startMessageId: string;
  arrivalCount: number;
  closed: boolean;
  createdAt: string;
}

export interface LiveAnalysisPoint {
  messageId: string;
  messageText: string;
  turnNumber: number;
  segmentIndex: number;
  verdict: DriftVerdict;
  fireChannel: DriftFireChannel | null;
  driftP: number | null;
  mu: number | null;
  sigma: number | null;
  zScore: number | null;
  immediateThreshold: number | null;
  expandedText: string | null;
}

export interface LiveAnalysisView {
  threadId: string;
  mode: ThreadAnalysisMode;
  params: {
    segmentThreshold: number;
    immediateK: number;
    sigmaFloor: number;
    lambda: number;
    delta: number;
    minSamples: number;
    coldStartTurns: number;
    embeddingModelId: string;
  };
  segments: LiveAnalysisSegment[];
  points: LiveAnalysisPoint[];
  /** True while some user arrivals have no verdict row yet. */
  pending: boolean;
}

export async function fetchThreadAnalysis(threadId: string): Promise<LiveAnalysisView> {
  const res = await fetch(`/api/threads/${threadId}/analysis`);
  if (!res.ok) throw new Error(`Failed to fetch thread analysis: ${res.statusText}`);
  return res.json();
}

export interface Thread {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_THREAD_TITLE = 'New Chat';

export const TITLE_GENERATING_SENTINEL = 'New Chat ...';

/** Telemetry for one assistant message (backend `message_usage`, 1:1). */
export interface MessageUsage {
  model: string;
  providerId: string;
  promptTokens: number;
  completionTokens: number;
  /** Provider-reported reasoning tokens (DeepInfra reports 0 even when reasoning). */
  reasoningTokens: number | null;
  /** Our estimate from reasoning content length (NULL when no reasoning). */
  estimatedReasoningTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: string;
  finishReason: MessageFinishReason;
  latencyMs: number | null;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  usage: MessageUsage | null;
  /** Live-gate verdict on user arrivals; null elsewhere and when off. */
  driftVerdict?: MessageDriftVerdict | null;
}

/**
 * Request de-dupe (singleflight), NOT a cache: an entry lives only while its
 * request is in flight and is deleted the moment it settles. Concurrent
 * duplicates (dev StrictMode double-mount, loader-revalidation pile-ups)
 * share that single request; any later sequential call always re-fetches
 * fresh data.
 */
const inflightGets = new Map<string, Promise<unknown>>();

function coalesceGet<T>(url: string, run: () => Promise<T>): Promise<T> {
  const inflight = inflightGets.get(url);
  if (inflight) return inflight as Promise<T>;
  const promise = run().finally(() => inflightGets.delete(url));
  inflightGets.set(url, promise);
  return promise;
}

export function fetchThreads(): Promise<Thread[]> {
  return coalesceGet('/api/threads', async () => {
    const res = await fetch('/api/threads');
    if (!res.ok) throw new Error(`Failed to fetch threads: ${res.statusText}`);
    return res.json();
  });
}

export async function createThread(): Promise<Thread> {
  const res = await fetch('/api/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Failed to create thread: ${res.statusText}`);
  return res.json();
}

export async function renameThread(threadId: string, title: string): Promise<Thread> {
  const res = await fetch(`/api/threads/${threadId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Failed to rename thread: ${res.statusText}`);
  return res.json();
}

export async function deleteThread(threadId: string): Promise<void> {
  const res = await fetch(`/api/threads/${threadId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete thread: ${res.statusText}`);
}

export function fetchMessages(threadId: string): Promise<Message[]> {
  const url = `/api/threads/${threadId}/messages`;
  return coalesceGet(url, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch messages: ${res.statusText}`);
    return res.json();
  });
}

/** Edits the thread's last message. Empty content is rejected by the API. */
export async function updateMessage(
  threadId: string,
  messageId: string,
  content: string,
): Promise<Message> {
  const res = await fetch(`/api/threads/${threadId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Failed to update message: ${res.statusText}`);
  return res.json();
}

/** Aggregated thread statistics from message_usage. */
export interface ThreadSummary {
  threadId: string;
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  totalCostUsd: string;
  cachedCostUsd: string;
  totalTokens: {
    prompt: number;
    completion: number;
    cached: number;
    reasoning: number;
    total: number;
  };
  primaryModel: string | null;
  primaryModelPricing: {
    inputPricePerMillion: number | null;
    outputPricePerMillion: number | null;
    cachedPricePerMillion: number | null;
    cachedRateMultiplier: number | null;
  } | null;
  contextUsage: {
    used: number;
    limit: number | null;
    percentage: number | null;
  };
  createdAt: string;
}

export function fetchThreadSummary(threadId: string): Promise<ThreadSummary | null> {
  const url = `/api/threads/${threadId}/summary`;
  return coalesceGet(url, async () => {
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`Failed to fetch thread summary: ${res.statusText}`);
    }
    return res.json();
  });
}

/** Refresh model pricing from provider API. */
export async function refreshModelPricing(): Promise<{
  success: boolean;
  modelsUpdated: number;
  error?: string;
  rateLimited?: boolean;
  retryAfter?: number; // seconds
}> {
  const res = await fetch('/api/models/refresh', {
    method: 'POST',
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: res.statusText }));
    return {
      success: false,
      modelsUpdated: 0,
      error: errorData.error ?? errorData.message ?? 'Failed to refresh',
      rateLimited: errorData.rateLimited,
      retryAfter: errorData.retryAfter,
    };
  }
  const data = await res.json();
  if (data.rateLimited) {
    return {
      success: true,
      modelsUpdated: 0,
      rateLimited: true,
      retryAfter: 0,
    };
  }
  return data;
}

export type Role = 'user' | 'assistant' | 'system';
export type MessageFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'timeout'
  | 'interrupted'
  | 'error';

/** The deployment feature-flag surfaces the chrome is driven from. */
export interface AppConfig {
  /** off|heuristic|always — `off` hides the Analysis tab and bubble tints. */
  threadAnalysisMode: 'off' | 'heuristic' | 'always';
  /** Which features the deployment runs; read through the feature registry. */
  features: unknown;
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
/** Recorded end of an arrival's rewrite try; mirrors backend ExpandOutcome. */
export type DriftExpandOutcome =
  | 'accepted'
  | 'failed_refused'
  | 'failed_quality'
  | 'failed_inference'
  | 'failed';

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
  closedByChannel: 'immediate' | 'slow' | null;
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
  rewrittenText: string | null;
  /**
   * Recorded end of the arrival's rewrite try. `accepted` renders the rewrite
   * cell; any `failed_*` marks the cell (full story on hover); null means no
   * rewrite was attempted.
   */
  expandOutcome: DriftExpandOutcome | null;
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

export async function backfillThreadAnalysis(threadId: string): Promise<LiveAnalysisView> {
  const res = await fetch(`/api/threads/${threadId}/analysis/backfill`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to backfill thread analysis: ${res.statusText}`);
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

/** Telemetry for one assistant message (backend `message_usage` chat row). */
export interface MessageUsage {
  model: string;
  /** Null when no provider response exists (estimated spends). */
  providerId: string | null;
  /** Null when the exchange ended before the provider reported tokens. */
  promptTokens: number | null;
  completionTokens: number | null;
  /** True when the tokens and cost were counted locally, not provider-reported. */
  estimated: boolean;
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
  /**
   * Rows of a forked-away or failed exchange: kept for usage tracking but
   * hidden from the chat stream and live analysis.
   */
  abandoned?: boolean;
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

export type Handover = {
  thread: Thread;
  /** The arrival's stored copy, the fresh thread's first message, awaiting its reply. */
  message: { id: string; content: string };
};

/**
 * How a handover request ended: the arrival moved, or nothing moved yet
 * because the old thread's memory is still being saved; asking again
 * picks up where it left off.
 */
export type HandoverOutcome = { kind: 'moved'; handover: Handover } | { kind: 'saving-memory' };

async function errorCodeOrNull(res: Response): Promise<unknown> {
  try {
    const body = (await res.json()) as { errorCode?: unknown };
    return body.errorCode ?? null;
  } catch {
    return null;
  }
}

/**
 * Moves the thread's paused arrival out into a fresh thread, where the
 * server stores it as the first message. The caller then asks for its reply.
 */
export async function handOverArrival(
  threadId: string,
  messageId: string,
): Promise<HandoverOutcome> {
  const res = await fetch(`/api/threads/${threadId}/handover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId }),
  });
  if (res.status === 503 && (await errorCodeOrNull(res)) === 'capture_pending') {
    return { kind: 'saving-memory' };
  }
  if (!res.ok) throw new Error(`Failed to start a new chat: ${res.statusText}`);
  return { kind: 'moved', handover: await res.json() };
}

export type ResumeDraft = { messageId: string; text: string };

/**
 * The arrival text of the thread's newest exchange when it was abandoned
 * (interrupted or failed) — the input prefills from it; null when nothing
 * is owed.
 */
export async function fetchResumeDraft(threadId: string): Promise<ResumeDraft | null> {
  const res = await fetch(`/api/threads/${threadId}/draft`);
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Failed to fetch resume draft: ${res.statusText}`);
  return res.json();
}

/** Explicit user stop of the thread's live exchange; false when none runs. */
export async function stopThreadExchange(threadId: string): Promise<boolean> {
  const res = await fetch(`/api/threads/${threadId}/stop`, { method: 'POST' });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Failed to stop exchange: ${res.statusText}`);
  return true;
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
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error ?? 'Failed to update message');
  }
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
  /** Composition of `totalCostUsd` (all USD decimal strings). */
  costBreakdown: {
    chat: string;
    embedding: string;
    rewrite: string;
    judge: string;
    memory: string;
  };
  totalTokens: {
    prompt: number;
    completion: number;
    cached: number;
    reasoning: number;
    total: number;
  };
  primaryModel: string | null;
  /** Every model the thread spent on, grouped by model id. */
  models: Array<{
    modelId: string;
    roles: Array<'chat' | 'embedding' | 'rewrite' | 'judge' | 'memory'>;
    pricing: {
      inputPricePerMillion: number | null;
      outputPricePerMillion: number | null;
      cachedPricePerMillion: number | null;
      cachedRateMultiplier: number | null;
    } | null;
  }>;
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

// ── Memory API ─────────────────────────────────────────────────────────────

export const FACT_CATEGORIES = [
  'preferences',
  'interests',
  'goals',
  'relationships',
  'work',
  'location',
  'credentials',
  'other',
] as const;

export interface UserFact {
  id: string;
  content: string;
  category: string;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  modelId: string;
  sourceMessageId: string | null;
  /** When the Fact became true, as stated in conversation; null when never stated. */
  validAt: string | null;
  invalidAt: string | null;
  suppressed: boolean;
  createdAt: string;
}

export interface UserSettings {
  memoryEnabled: boolean;
  memoryBlockedCategories: string[];
}

export async function fetchUserFacts(): Promise<UserFact[]> {
  const res = await fetch('/api/memory/facts');
  if (!res.ok) throw new Error(`Failed to fetch user facts: ${res.statusText}`);
  return res.json();
}

export async function updateUserFact(
  factId: string,
  patch: { content?: string } | { suppressed: boolean },
): Promise<UserFact> {
  const res = await fetch(`/api/memory/facts/${factId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error ?? 'Failed to update fact');
  }
  return res.json();
}

export async function deleteUserFact(factId: string): Promise<void> {
  const res = await fetch(`/api/memory/facts/${factId}`, { method: 'DELETE' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error ?? 'Failed to delete fact');
  }
}

export async function fetchUserSettings(): Promise<UserSettings> {
  const res = await fetch('/api/settings');
  if (!res.ok) throw new Error(`Failed to fetch user settings: ${res.statusText}`);
  return res.json();
}

export async function updateUserSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  const res = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error ?? 'Failed to update settings');
  }
  return res.json();
}

/** What an on-demand capture pass did (mirrors the backend report). */
export interface MemoryCaptureReport {
  /** False when memory is off: nothing was read. */
  memoryEnabled: boolean;
  /** Segments owing a capture; 0 means nothing new since the last pass. */
  owed: number;
  failed: number;
  added: number;
  /** Known Facts restated or corrected, now replaced by the newer reading. */
  replaced: number;
}

/**
 * Runs the thread's capture pass now, from where the last one stopped.
 * Throws when the pass fails, carrying the server's reason.
 */
export async function captureThreadMemory(threadId: string): Promise<MemoryCaptureReport> {
  // No body, so no JSON content-type: Fastify rejects an empty JSON body.
  const res = await fetch(`/api/threads/${threadId}/capture-memory`, { method: 'POST' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error ?? 'Failed to capture memory');
  }
  return res.json();
}

import { type Endpoint, type RequestOf, pathOf } from '@ari/lib/api/schemas/common/endpoint';
import { getConfig } from '@ari/lib/api/schemas/config/config';
import { editMessage } from '@ari/lib/api/schemas/messages/edit';
import { listMessages } from '@ari/lib/api/schemas/messages/list';
import { refreshModels } from '@ari/lib/api/schemas/models/models';
import { deleteFact, listFacts, updateFact } from '@ari/lib/api/schemas/settings/facts';
import {
  type SettingsPatch,
  getSettings,
  updateSettings,
} from '@ari/lib/api/schemas/settings/settings';
import {
  backfillThreadAnalysis as backfillThreadAnalysisEndpoint,
  threadAnalysis,
} from '@ari/lib/api/schemas/threads/analysis';
import { captureThreadMemory as captureThreadMemoryEndpoint } from '@ari/lib/api/schemas/threads/capture-memory';
import { threadDraft } from '@ari/lib/api/schemas/threads/draft';
import { generateTitle } from '@ari/lib/api/schemas/threads/generate-title';
import { type Handover, handOver } from '@ari/lib/api/schemas/threads/handover';
import { stopExchange } from '@ari/lib/api/schemas/threads/stop';
import { threadSummary } from '@ari/lib/api/schemas/threads/summary';
import {
  createThread as createThreadEndpoint,
  deleteThread as deleteThreadEndpoint,
  listThreads,
  renameThread as renameThreadEndpoint,
} from '@ari/lib/api/schemas/threads/thread';

export type {
  FireChannel,
  GateVerdict,
  MessageDriftVerdict,
} from '@ari/lib/api/schemas/common/driftGate';
export type {
  ExpandOutcome,
  LiveAnalysisPoint,
  LiveAnalysisView,
  ThreadAnalysisMode,
} from '@ari/lib/api/schemas/threads/analysis';
export { FACT_CATEGORIES, type FactCategory } from '@ari/lib/api/schemas/settings/facts';
export type { MemoryCaptureReport } from '@ari/lib/api/schemas/threads/capture-memory';
export type { UserSettings } from '@ari/lib/api/schemas/settings/settings';
export type { UserFact } from '@ari/lib/api/schemas/settings/facts';
export type { FinishReason, Message, MessageUsage } from '@ari/lib/api/schemas/messages/message';
export type { ThreadSummary } from '@ari/lib/api/schemas/threads/summary';
export type { Thread } from '@ari/lib/api/schemas/threads/thread';

export const DEFAULT_THREAD_TITLE = 'New Chat';

export const TITLE_GENERATING_SENTINEL = 'New Chat ...';

/** Calls `target` with `body` as JSON. */
function sendJson<E extends Endpoint>(
  target: E,
  params: Readonly<Record<string, string>>,
  body: RequestOf<E>,
): Promise<Response> {
  return fetch(pathOf(target, params), {
    method: target.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The server's reason for a failed call, or `fallback` when it gave none. */
async function errorMessageOf(res: Response, fallback: string) {
  const body = await res.json().catch(() => null);
  return typeof body?.error === 'string' ? body.error : fallback;
}

export async function fetchConfig() {
  const res = await fetch(pathOf(getConfig));
  if (!res.ok) throw new Error(`Failed to fetch config: ${res.statusText}`);
  return res.json();
}

export async function fetchThreadAnalysis(threadId: string) {
  const res = await fetch(pathOf(threadAnalysis, { id: threadId }));
  if (!res.ok) throw new Error(`Failed to fetch thread analysis: ${res.statusText}`);
  return res.json();
}

export async function backfillThreadAnalysis(threadId: string) {
  const res = await fetch(pathOf(backfillThreadAnalysisEndpoint, { id: threadId }), {
    method: backfillThreadAnalysisEndpoint.method,
  });
  if (!res.ok) throw new Error(`Failed to backfill thread analysis: ${res.statusText}`);
  return res.json();
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

export function fetchThreads() {
  const url = pathOf(listThreads);
  return coalesceGet(url, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch threads: ${res.statusText}`);
    return res.json();
  });
}

export async function createThread() {
  const res = await sendJson(createThreadEndpoint, {}, {});
  if (!res.ok) throw new Error(`Failed to create thread: ${res.statusText}`);
  return res.json();
}

export async function renameThread(threadId: string, title: string) {
  const res = await sendJson(renameThreadEndpoint, { id: threadId }, { title });
  if (!res.ok) throw new Error(`Failed to rename thread: ${res.statusText}`);
  return res.json();
}

export async function deleteThread(threadId: string) {
  const res = await fetch(pathOf(deleteThreadEndpoint, { id: threadId }), {
    method: deleteThreadEndpoint.method,
  });
  if (!res.ok) throw new Error(`Failed to delete thread: ${res.statusText}`);
}

/** Queues the Thread's titling; `forced` replaces any title it already has. */
export function requestTitle(threadId: string, forced: boolean) {
  return sendJson(generateTitle, { id: threadId }, { forced });
}

/**
 * How a handover request ended: the arrival moved, or nothing moved yet
 * because the old thread's memory is still being saved; asking again
 * picks up where it left off.
 */
type HandoverOutcome = { kind: 'moved'; handover: Handover } | { kind: 'saving-memory' };

async function errorCodeOrNull(res: Response) {
  const body = await res.json().catch(() => null);
  return body?.errorCode ?? null;
}

/**
 * Moves the thread's paused arrival out into a fresh thread, where the
 * server stores it as the first message. The caller then asks for its reply.
 */
export async function handOverArrival(
  threadId: string,
  messageId: string,
): Promise<HandoverOutcome> {
  const res = await sendJson(handOver, { id: threadId }, { messageId });
  if (res.status === 503 && (await errorCodeOrNull(res)) === 'capture_pending') {
    return { kind: 'saving-memory' };
  }
  if (!res.ok) throw new Error(`Failed to start a new chat: ${res.statusText}`);
  return { kind: 'moved', handover: await res.json() };
}

/**
 * The arrival text of the thread's newest exchange when it was abandoned
 * (interrupted or failed) — the input prefills from it; null when nothing
 * is owed.
 */
export async function fetchResumeDraft(threadId: string) {
  const res = await fetch(pathOf(threadDraft, { id: threadId }));
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`Failed to fetch resume draft: ${res.statusText}`);
  return res.json();
}

/** Explicit user stop of the thread's live exchange; false when none runs. */
export async function stopThreadExchange(threadId: string) {
  const res = await fetch(pathOf(stopExchange, { id: threadId }), { method: stopExchange.method });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Failed to stop exchange: ${res.statusText}`);
  return true;
}

export function fetchMessages(threadId: string) {
  const url = pathOf(listMessages, { id: threadId });
  return coalesceGet(url, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch messages: ${res.statusText}`);
    return res.json();
  });
}

/** Edits the thread's last message. Empty content is rejected by the API. */
export async function updateMessage(threadId: string, messageId: string, content: string) {
  const res = await sendJson(editMessage, { id: threadId, messageId }, { content });
  if (!res.ok) throw new Error(await errorMessageOf(res, 'Failed to update message'));
  return res.json();
}

export function fetchThreadSummary(threadId: string) {
  const url = pathOf(threadSummary, { id: threadId });
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
export async function refreshModelPricing() {
  const res = await fetch(pathOf(refreshModels), { method: refreshModels.method });

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

export async function fetchUserFacts() {
  const res = await fetch(pathOf(listFacts));
  if (!res.ok) throw new Error(`Failed to fetch user facts: ${res.statusText}`);
  return res.json();
}

export async function updateUserFact(factId: string, patch: RequestOf<typeof updateFact>) {
  const res = await sendJson(updateFact, { id: factId }, patch);
  if (!res.ok) throw new Error(await errorMessageOf(res, 'Failed to update fact'));
  return res.json();
}

export async function deleteUserFact(factId: string) {
  const res = await fetch(pathOf(deleteFact, { id: factId }), { method: deleteFact.method });
  if (!res.ok) throw new Error(await errorMessageOf(res, 'Failed to delete fact'));
}

export async function fetchUserSettings() {
  const res = await fetch(pathOf(getSettings));
  if (!res.ok) throw new Error(`Failed to fetch user settings: ${res.statusText}`);
  return res.json();
}

export async function updateUserSettings(patch: SettingsPatch) {
  const res = await sendJson(updateSettings, {}, patch);
  if (!res.ok) throw new Error(await errorMessageOf(res, 'Failed to update settings'));
  return res.json();
}

/**
 * Runs the thread's capture pass now, from where the last one stopped.
 * Throws when the pass fails, carrying the server's reason.
 */
export async function captureThreadMemory(threadId: string) {
  // No body, so no JSON content-type: Fastify rejects an empty JSON body.
  const res = await fetch(pathOf(captureThreadMemoryEndpoint, { id: threadId }), {
    method: captureThreadMemoryEndpoint.method,
  });
  if (!res.ok) throw new Error(await errorMessageOf(res, 'Failed to capture memory'));
  return res.json();
}

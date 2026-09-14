export type Role = 'user' | 'assistant' | 'system';
export type MessageFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'timeout'
  | 'interrupted';

export interface Thread {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/** Telemetry for one assistant message (backend `message_usage`, 1:1). */
export interface MessageUsage {
  model: string;
  provider_id: string;
  prompt_tokens: number;
  completion_tokens: number;
  /** NULL when the provider doesn't report these. */
  reasoning_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: string;
  finish_reason: MessageFinishReason;
  latency_ms: number | null;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  created_at: string;
  usage: MessageUsage | null;
}

export async function fetchThreads(): Promise<Thread[]> {
  const res = await fetch('/api/threads');
  if (!res.ok) throw new Error(`Failed to fetch threads: ${res.statusText}`);
  return res.json();
}

export async function createThread(title: string): Promise<Thread> {
  const res = await fetch('/api/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
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

export async function fetchMessages(threadId: string): Promise<Message[]> {
  const res = await fetch(`/api/threads/${threadId}/messages`);
  if (!res.ok) throw new Error(`Failed to fetch messages: ${res.statusText}`);
  return res.json();
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

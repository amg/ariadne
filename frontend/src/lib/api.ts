export type Thread = { id: string; title: string; created_at: string };

export type Role = 'user' | 'assistant';
export type Message = { id: string; role: Role; content: string; created_at: string };

const API_BASE = '/api';

export async function fetchThreads(): Promise<Thread[]> {
  const res = await fetch(`${API_BASE}/threads`);
  return res.json();
}

export async function createThread(title: string): Promise<Thread> {
  const res = await fetch(`${API_BASE}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return res.json();
}

export async function fetchMessages(threadId: string): Promise<Message[]> {
  const res = await fetch(`${API_BASE}/threads/${threadId}/messages`);
  return res.json();
}

export async function postMessage(threadId: string, content: string): Promise<Message> {
  const res = await fetch(`${API_BASE}/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  const data = (await res.json()) as { message: Message };
  return data.message;
}

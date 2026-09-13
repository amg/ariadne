export type Role = 'user' | 'assistant' | 'system';

export interface Thread {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  created_at: string;
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

export async function fetchMessages(threadId: string): Promise<Message[]> {
  const res = await fetch(`/api/threads/${threadId}/messages`);
  if (!res.ok) throw new Error(`Failed to fetch messages: ${res.statusText}`);
  return res.json();
}

export async function postMessage(threadId: string, content: string): Promise<Message> {
  const res = await fetch(`/api/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Failed to post message: ${res.statusText}`);
  const data = await res.json();
  return data.message;
}

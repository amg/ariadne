import AppLayout from '@/components/layout/AppLayout';
import { createThread, fetchMessages, fetchThreads, postMessage } from '@/lib/api';
import EmptyPage from '@/pages/EmptyPage';
import { createBrowserRouter, redirect } from 'react-router';

type RouteArgs = { params: { threadId?: string }; request: Request };

async function rootLoader() {
  return { threads: await fetchThreads() };
}

async function messagesLoader({ params }: RouteArgs) {
  if (!params.threadId) return { messages: [] };
  return { messages: await fetchMessages(params.threadId) };
}

async function newThreadAction() {
  const thread = await createThread('New Chat');
  return redirect(`/threads/${thread.id}`);
}

async function sendMessageAction({ params, request }: RouteArgs) {
  const formData = await request.formData();
  const content = String(formData.get('content') ?? '').trim();
  if (!params.threadId || !content) return null;
  await postMessage(params.threadId, content);
  return null;
}

export const router = createBrowserRouter([
  {
    id: 'root',
    path: '/',
    Component: AppLayout,
    loader: rootLoader,
    children: [
      { index: true, Component: EmptyPage },
      { path: 'threads/new', action: newThreadAction },
      {
        path: 'threads/:threadId',
        loader: messagesLoader,
        action: sendMessageAction,
        lazy: async () => {
          const mod = await import('@/pages/ChatPage');
          return { Component: mod.default };
        },
      },
    ],
  },
]);

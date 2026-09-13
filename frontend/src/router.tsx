import { action as newThreadAction } from '@/actions/threads/newThread';
import { action as sendMessageAction } from '@/actions/threads/sendMessage';
import AboutPage from '@/pages/AboutPage';
import AppLayout, { loader as rootLoader } from '@/pages/AppLayout';
import EmptyPage from '@/pages/EmptyPage';
import { fetchThreads } from '@/services/api';
import { createBrowserRouter, redirect } from 'react-router';

export const router = createBrowserRouter([
  {
    id: 'root',
    path: '/',
    Component: AppLayout,
    loader: rootLoader,
    children: [
      {
        index: true,
        Component: EmptyPage,
        // Redirect to the newest thread; EmptyPage only renders when none exist.
        loader: async () => {
          const threads = await fetchThreads();
          return threads.length > 0 ? redirect(`/threads/${threads[0].id}`) : null;
        },
      },
      // Static page — no loader; a route only gets data from its own module.
      { path: 'about', Component: AboutPage },
      { path: 'threads/new', action: newThreadAction },
      {
        // Loader co-located in the page module; routed here via lazy.
        path: 'threads/:threadId',
        action: sendMessageAction,
        lazy: async () => {
          const { default: Component, loader } = await import('@/pages/ChatPage');
          return { Component, loader };
        },
      },
    ],
  },
]);

import { action as deleteThreadAction } from '@/actions/threads/deleteThread';
import { action as newThreadAction } from '@/actions/threads/newThread';
import { action as renameThreadAction } from '@/actions/threads/renameThread';
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
      // Action-only route, same pattern as above.
      { path: 'threads/:threadId/rename', action: renameThreadAction },
      { path: 'threads/:threadId/delete', action: deleteThreadAction },
      {
        // Loader co-located in the page module; routed here via lazy.
        path: 'threads/:threadId',
        lazy: async () => {
          const { default: Component, loader } = await import('@/pages/ChatPage');
          return { Component, loader };
        },
      },
    ],
  },
]);

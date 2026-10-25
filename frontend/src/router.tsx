import { action as deleteThreadAction } from '@/actions/threads/deleteThread';
import { action as generateTitleAction } from '@/actions/threads/generateTitle';
import { action as newThreadAction } from '@/actions/threads/newThread';
import { action as renameThreadAction } from '@/actions/threads/renameThread';
import AboutPage from '@/pages/AboutPage';
import AppLayout, { loader as rootLoader } from '@/pages/AppLayout';
import EmptyPage from '@/pages/EmptyPage';
import MemoryScreen from '@/pages/MemoryScreen';
import SettingsPage from '@/pages/SettingsPage';
import { fetchThreads } from '@/services/api';
import type { RootLoaderData } from '@/types/pages';
import type { ReactNode } from 'react';
import { Navigate, createBrowserRouter, redirect, useRouteLoaderData } from 'react-router';
import { EmailPasswordPreBuiltUI } from 'supertokens-auth-react/recipe/emailpassword/prebuiltui';
import { getRoutingComponent } from 'supertokens-auth-react/ui';

/** A page that exists only while the deployment runs Memory; without it the app goes home. */
function MemoryPage({ children }: { children: ReactNode }) {
  const { features } = useRouteLoaderData('root') as RootLoaderData;
  return features.memory ? children : <Navigate to="/" replace />;
}

export const router = createBrowserRouter([
  {
    path: '/auth/*',
    Component: () => getRoutingComponent([EmailPasswordPreBuiltUI]),
  },
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
      // Static pages — no loader; a route only gets data from its own module.
      { path: 'about', Component: AboutPage },
      // Every setting today belongs to Memory, so its page goes with it.
      {
        path: 'memory',
        element: (
          <MemoryPage>
            <MemoryScreen />
          </MemoryPage>
        ),
      },
      {
        path: 'settings',
        element: (
          <MemoryPage>
            <SettingsPage />
          </MemoryPage>
        ),
      },
      { path: 'threads/new', action: newThreadAction },
      // Action-only route, same pattern as above.
      { path: 'threads/:threadId/rename', action: renameThreadAction },
      { path: 'threads/:threadId/delete', action: deleteThreadAction },
      { path: 'threads/:threadId/generate-title', action: generateTitleAction },
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

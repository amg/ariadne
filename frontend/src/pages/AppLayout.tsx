import AppShell from '@/components/layout/AppShell';
import ThreadSidebar from '@/components/layout/ThreadSidebar';
import { type Thread, fetchThreads } from '@/services/api';
import { Outlet, useFetcher, useMatch, useNavigate, useRouteLoaderData } from 'react-router';

export async function loader() {
  return { threads: await fetchThreads() };
}

// Framework entry for the app chrome: reads route state, delegates to the pure shell.
export default function AppLayout() {
  const { threads } = useRouteLoaderData('root') as { threads: Thread[] };
  const match = useMatch('/threads/:threadId');
  const navigate = useNavigate();
  const createFetcher = useFetcher();
  const renameFetcher = useFetcher({ key: 'rename-thread' });

  // Optimistic title while the rename fetcher is in flight.
  const pendingRename = renameFetcher.formData
    ? {
        threadId: String(renameFetcher.formData.get('threadId') ?? ''),
        title: String(renameFetcher.formData.get('title') ?? ''),
      }
    : null;

  return (
    <AppShell
      sidebar={
        <ThreadSidebar
          threads={threads}
          activeThreadId={match?.params.threadId ?? null}
          onSelectThread={(id) => navigate(`/threads/${id}`)}
          onNewChat={() => createFetcher.submit(null, { method: 'post', action: '/threads/new' })}
          onRename={(id, title) =>
            renameFetcher.submit(
              { threadId: id, title },
              { method: 'post', action: `/threads/${id}/rename` },
            )
          }
          pendingRename={pendingRename}
          onAbout={() => navigate('/about')}
        />
      }
    >
      <Outlet />
    </AppShell>
  );
}

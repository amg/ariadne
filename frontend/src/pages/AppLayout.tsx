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

  return (
    <AppShell
      sidebar={
        <ThreadSidebar
          threads={threads}
          activeThreadId={match?.params.threadId ?? null}
          onSelectThread={(id) => navigate(`/threads/${id}`)}
          onNewChat={() => createFetcher.submit(null, { method: 'post', action: '/threads/new' })}
          onAbout={() => navigate('/about')}
        />
      }
    >
      <Outlet />
    </AppShell>
  );
}

import AppShell from '@/components/layout/AppShell';
import ThreadSidebar from '@/components/layout/ThreadSidebar';
import { type Thread, fetchThreads } from '@/services/api';
import {
  Outlet,
  useFetcher,
  useLocation,
  useMatch,
  useNavigate,
  useRouteLoaderData,
} from 'react-router';

export async function loader() {
  return { threads: await fetchThreads() };
}

// Framework entry for the app chrome: reads route state, delegates to the pure shell.
export default function AppLayout() {
  const { threads } = useRouteLoaderData('root') as { threads: Thread[] };
  const match = useMatch('/threads/:threadId');
  const location = useLocation();
  const navigate = useNavigate();
  const createFetcher = useFetcher();
  const renameFetcher = useFetcher({ key: 'rename-thread' });
  const deleteFetcher = useFetcher({ key: 'delete-thread' });

  // Optimistic title while the rename fetcher is in flight.
  const pendingRename = renameFetcher.formData
    ? {
        threadId: String(renameFetcher.formData.get('threadId') ?? ''),
        title: String(renameFetcher.formData.get('title') ?? ''),
      }
    : null;

  // Hide the thread optimistically while its delete is in flight.
  const pendingDeleteId = deleteFetcher.formData
    ? String(deleteFetcher.formData.get('threadId') ?? '')
    : null;
  const visibleThreads = pendingDeleteId
    ? threads.filter((t) => t.id !== pendingDeleteId)
    : threads;

  return (
    <AppShell
      sidebar={
        <ThreadSidebar
          threads={visibleThreads}
          activeThreadId={match?.params.threadId ?? null}
          onSelectThread={(id) => navigate(`/threads/${id}`)}
          onNewChat={() => createFetcher.submit(null, { method: 'post', action: '/threads/new' })}
          onRename={(id, title) =>
            renameFetcher.submit(
              { threadId: id, title },
              { method: 'post', action: `/threads/${id}/rename` },
            )
          }
          onDelete={(id) =>
            deleteFetcher.submit(
              // `from` tells the action where we are so it can redirect home
              // only when the thread being viewed is the one being deleted.
              { threadId: id, from: location.pathname },
              { method: 'post', action: `/threads/${id}/delete` },
            )
          }
          pendingRename={pendingRename}
          onAbout={() => navigate('/about')}
        />
      }
    >
      {/* Keyed by thread so the chat page remounts (fresh useChat state) when switching. */}
      <Outlet key={match?.params.threadId ?? 'empty'} />
    </AppShell>
  );
}

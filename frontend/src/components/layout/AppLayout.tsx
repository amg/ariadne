import ThreadSidebar from '@/components/layout/ThreadSidebar';
import type { Thread } from '@/lib/api';
import { Outlet, useMatch, useRouteLoaderData } from 'react-router';

export default function AppLayout() {
  const { threads } = useRouteLoaderData('root') as { threads: Thread[] };
  const match = useMatch('/threads/:threadId');
  const activeThreadId = match?.params.threadId ?? null;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <ThreadSidebar threads={threads} activeThreadId={activeThreadId} />
      <main className="flex flex-1 flex-col bg-background">
        <Outlet />
      </main>
    </div>
  );
}

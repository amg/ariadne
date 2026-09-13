import type { Thread } from '@/lib/api';
import { Navigate, useRouteLoaderData } from 'react-router';

export default function EmptyPage() {
  const { threads } = useRouteLoaderData('root') as { threads: Thread[] };
  if (threads.length > 0) return <Navigate to={`/threads/${threads[0].id}`} replace />;
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      Select or create a chat to begin.
    </div>
  );
}

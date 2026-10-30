import { TITLE_GENERATING_SENTINEL } from '@/services/api';
import type { RootLoaderData } from '@/types/pages';
import { useMemo } from 'react';
import { useFetcher, useLocation } from 'react-router';

/**
 * The Threads the sidebar shows: the loaded ones, without a Thread whose
 * delete is in flight, and with the loading pulse in place of the title of
 * each Thread in `titlingThreadIds`.
 */
export function useOptimisticThreads({
  threads,
  titlingThreadIds,
}: {
  threads: RootLoaderData['threads'];
  titlingThreadIds: readonly string[];
}) {
  const location = useLocation();
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
  const visibleThreads = useMemo(() => {
    return threads
      .filter((t) => t.id !== pendingDeleteId)
      .map((t) =>
        titlingThreadIds.includes(t.id) ? { ...t, title: TITLE_GENERATING_SENTINEL } : t,
      );
  }, [threads, pendingDeleteId, titlingThreadIds]);

  return {
    visibleThreads,
    pendingRename,
    rename: (id: string, title: string) =>
      renameFetcher.submit(
        { threadId: id, title },
        { method: 'post', action: `/threads/${id}/rename` },
      ),
    remove: (id: string) =>
      deleteFetcher.submit(
        // `from` tells the action where we are so it can redirect home
        // only when the thread being viewed is the one being deleted.
        { threadId: id, from: location.pathname },
        { method: 'post', action: `/threads/${id}/delete` },
      ),
  };
}

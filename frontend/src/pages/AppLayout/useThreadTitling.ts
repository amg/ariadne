import type { action } from '@/actions/threads/generateTitle';
import { friendlyErrorMessage } from '@/services/errorCodes';
import { pushClient } from '@/services/push';
import type { RootLoaderData } from '@/types/pages';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import { toast } from 'sonner';

type GenerateTitleActionResult = Awaited<ReturnType<typeof action>>;

/**
 * Which Threads show the loading pulse in place of their title, and how to
 * ask for a new title. `revalidate` re-reads the Threads through the loaders.
 */
export function useThreadTitling({
  threads,
  revalidate,
}: {
  threads: RootLoaderData['threads'];
  revalidate: () => Promise<void>;
}) {
  const generateTitleFetcher = useFetcher();

  const generatingTitleThreadId = generateTitleFetcher.formData
    ? String(generateTitleFetcher.formData.get('threadId') ?? '')
    : null;

  // A queued titling accepted by the backend keeps the loading pulse until
  // the title actually lands — announced by the push channel, or visible on
  // the next refetch when push is down.
  const [queuedTitlingThreadId, setQueuedTitlingThreadId] = useState<string | null>(null);

  // A Thread that was titled outside any request of this tab joins the
  // sidebar through the root loader — one revalidation settles it.
  useEffect(
    () =>
      pushClient.subscribe('thread-titled', (event) => {
        setQueuedTitlingThreadId((queued) => (queued === event.threadId ? null : queued));
        revalidate();
      }),
    [revalidate],
  );

  // The refetch fallback: the loader's refresh shows the title, so the
  // pulse ends even if the announcement never arrived.
  useEffect(() => {
    if (!queuedTitlingThreadId) return;
    const titled = threads.some(
      (thread) => thread.id === queuedTitlingThreadId && thread.title !== null,
    );
    if (titled) setQueuedTitlingThreadId(null);
  }, [threads, queuedTitlingThreadId]);

  // Titling failures were previously invisible: the action swallowed them so
  // the pulse would still stop. Now the action settles a curated errorCode
  // (backend contract → friendly copy; raw provider text stays server-side)
  // and this effect toasts it — once per settled submission.
  const lastTitleResultRef = useRef<GenerateTitleActionResult | null>(null);
  useEffect(() => {
    const { state, data } = generateTitleFetcher;
    if (state !== 'idle' || !data) return;
    const result = data as GenerateTitleActionResult;
    if (lastTitleResultRef.current === result) return;
    lastTitleResultRef.current = result;
    if (result.ok) {
      if (result.queued && result.threadId) {
        setQueuedTitlingThreadId(result.threadId);
      }
      return;
    }
    toast.error('Title regeneration failed', {
      description: friendlyErrorMessage(result.errorCode),
    });
  }, [generateTitleFetcher]);

  const titlingThreadIds = useMemo(
    () => [generatingTitleThreadId, queuedTitlingThreadId].filter((id) => id !== null),
    [generatingTitleThreadId, queuedTitlingThreadId],
  );

  return {
    titlingThreadIds,
    regenerateTitle: (id: string) =>
      // formData (not null) so the sidebar/info panel flip to the loading
      // pulse immediately. `forced` tells the backend to title from the
      // thread's first segment instead of its first exchange.
      generateTitleFetcher.submit(
        { threadId: id, forced: 'true' },
        { method: 'post', action: `/threads/${id}/generate-title` },
      ),
  };
}

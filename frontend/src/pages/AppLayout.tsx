import type { GenerateTitleActionResult } from '@/actions/threads/generateTitle';
import AppShell from '@/components/layout/AppShell';
import ThreadInfoPanel from '@/components/layout/ThreadInfoPanel';
import ThreadSidebar from '@/components/layout/ThreadSidebar';
import {
  TITLE_GENERATING_SENTINEL,
  type Thread,
  type ThreadAnalysisMode,
  type ThreadSummary,
  fetchConfig,
  fetchThreadSummary,
  fetchThreads,
  refreshModelPricing,
} from '@/services/api';
import { friendlyErrorMessage } from '@/services/errorCodes';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Outlet,
  useFetcher,
  useLocation,
  useMatch,
  useNavigate,
  useRouteLoaderData,
} from 'react-router';
import { toast } from 'sonner';

export async function loader() {
  // Config failure degrades quietly: treat the analysis surface as on.
  let threadAnalysisMode: ThreadAnalysisMode = 'heuristic';
  try {
    threadAnalysisMode = (await fetchConfig()).threadAnalysisMode;
  } catch {
    // Surface falls back on; the backend still enforces its own flag.
  }
  return { threads: await fetchThreads(), threadAnalysisMode };
}

// Framework entry for the app chrome: reads route state, delegates to the pure shell.
export default function AppLayout() {
  const { threads, threadAnalysisMode } = useRouteLoaderData('root') as {
    threads: Thread[];
    threadAnalysisMode: ThreadAnalysisMode;
  };
  const match = useMatch('/threads/:threadId');
  const location = useLocation();
  const navigate = useNavigate();
  const createFetcher = useFetcher();
  const renameFetcher = useFetcher({ key: 'rename-thread' });
  const deleteFetcher = useFetcher({ key: 'delete-thread' });
  const generateTitleFetcher = useFetcher();

  const generatingTitleThreadId = generateTitleFetcher.formData
    ? String(generateTitleFetcher.formData.get('threadId') ?? '')
    : null;

  // Titling failures were previously invisible: the action swallowed them so
  // the pulse would still stop. Now the action settles a curated errorCode
  // (backend contract → friendly copy; raw provider text stays server-side)
  // and this effect toasts it — once per settled submission.
  const lastToastedTitleResultRef = useRef<GenerateTitleActionResult | null>(null);
  useEffect(() => {
    const { state, data } = generateTitleFetcher;
    if (state !== 'idle' || !data) return;
    const result = data as GenerateTitleActionResult;
    if (result.ok !== false || lastToastedTitleResultRef.current === result) return;
    lastToastedTitleResultRef.current = result;
    toast.error('Title regeneration failed', {
      description: friendlyErrorMessage(result.errorCode),
    });
  }, [generateTitleFetcher]);

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
        t.id === generatingTitleThreadId ? { ...t, title: TITLE_GENERATING_SENTINEL } : t,
      );
  }, [threads, pendingDeleteId, generatingTitleThreadId]);

  // Thread summary state
  const [threadSummary, setThreadSummary] = useState<ThreadSummary | null>(null);
  const [activeThreadTitle, setActiveThreadTitle] = useState<string | null | undefined>(undefined);
  const currentThreadId = match?.params.threadId ?? null;

  // Fetch the summary once per active thread. NOT keyed on `visibleThreads`:
  // that identity churns with every loader revalidation and fetcher submit,
  // and used to re-fetch (and 3x) the summary on a page reload.
  useEffect(() => {
    if (!currentThreadId) {
      setThreadSummary(null);
      return;
    }
    let stale = false;
    fetchThreadSummary(currentThreadId)
      .then((summary) => {
        if (!stale) setThreadSummary(summary);
      })
      .catch((err) => {
        if (stale) return;
        console.error('Failed to fetch thread summary:', err);
        setThreadSummary(null);
      });
    return () => {
      stale = true;
    };
  }, [currentThreadId]);

  // Keep the info-panel/chat title in sync with sidebar state (sentinel pulse
  // during in-flight titling, optimistic delete) without any I/O.
  useEffect(() => {
    const thread = currentThreadId
      ? visibleThreads.find((t) => t.id === currentThreadId)
      : undefined;
    setActiveThreadTitle(thread?.title);
  }, [currentThreadId, visibleThreads]);

  // Handle model pricing refresh with rate limit handling
  const handleRefreshPricing = async () => {
    const result = await refreshModelPricing();
    if (result.rateLimited) {
      console.log('Model pricing refresh ignored (too soon).');
      return result;
    }
    if (result.success) {
      console.log(`Refreshed ${result.modelsUpdated} model configs`);
      // Refetch thread summary to get updated context limit
      if (currentThreadId) {
        const summary = await fetchThreadSummary(currentThreadId);
        setThreadSummary(summary);
      }
    } else {
      console.error('Failed to refresh model pricing:', result.error);
    }
    return result;
  };

  // Refresh thread summary (cost, tokens, etc.) - called after each message
  const handleRefreshThreadSummary = async () => {
    if (!currentThreadId) return;
    try {
      const summary = await fetchThreadSummary(currentThreadId);
      setThreadSummary(summary);
    } catch (err) {
      console.error('Failed to refresh thread summary:', err);
    }
  };

  return (
    <AppShell
      sidebar={
        <ThreadSidebar
          threads={visibleThreads}
          activeThreadId={match?.params.threadId ?? null}
          onSelectThread={(id) =>
            // Preserve the query string (e.g. ?mode=analyze) so analysis
            // viewing carries across thread switches.
            navigate({ pathname: `/threads/${id}`, search: location.search, hash: location.hash })
          }
          onNewChat={() => createFetcher.submit(null, { method: 'post', action: '/threads/new' })}
          onRename={(id, title) =>
            renameFetcher.submit(
              { threadId: id, title },
              { method: 'post', action: `/threads/${id}/rename` },
            )
          }
          onRegenerateTitle={(id) =>
            // formData (not null) so `generatingTitleThreadId` above flips the
            // sidebar/info panel to the loading pulse immediately.
            generateTitleFetcher.submit(
              { threadId: id },
              { method: 'post', action: `/threads/${id}/generate-title` },
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
      infoPanel={
        <ThreadInfoPanel
          summary={threadSummary}
          threadTitle={activeThreadTitle}
          onRefreshPricing={handleRefreshPricing}
        />
      }
    >
      {/* Keyed by thread so the chat page remounts (fresh useChat state) when switching. */}
      <Outlet
        key={match?.params.threadId ?? 'empty'}
        context={{
          analysisMode: threadAnalysisMode,
          generateTitle: (id: string) => {
            generateTitleFetcher.submit(
              { threadId: id },
              { method: 'post', action: `/threads/${id}/generate-title` },
            );
          },
          refreshThreadSummary: handleRefreshThreadSummary,
        }}
      />
    </AppShell>
  );
}

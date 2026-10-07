import type { GenerateTitleActionResult } from '@/actions/threads/generateTitle';
import AppShell from '@/components/layout/AppShell';
import ThreadInfoPanel from '@/components/layout/ThreadInfoPanel';
import ThreadSidebar from '@/components/layout/ThreadSidebar';
import { FEATURE_DEFAULTS, type FeatureFlags, featuresFromServer } from '@/config/features';
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
import { pushClient } from '@/services/push';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Outlet,
  useFetcher,
  useLocation,
  useMatch,
  useNavigate,
  useRevalidator,
  useRouteLoaderData,
} from 'react-router';
import { redirect } from 'react-router';
import { toast } from 'sonner';
import Session, { SessionAuth } from 'supertokens-auth-react/recipe/session';

export async function loader() {
  if (!(await Session.doesSessionExist())) {
    return redirect('/auth');
  }
  // Config failure degrades quietly, and the two fallbacks differ on
  // purpose: the analysis surface stays on (the backend still enforces its
  // own flag), while every feature toggle falls back off.
  let threadAnalysisMode: ThreadAnalysisMode = 'heuristic';
  let features: FeatureFlags = FEATURE_DEFAULTS;
  try {
    const config = await fetchConfig();
    threadAnalysisMode = config.threadAnalysisMode;
    features = featuresFromServer(config.features);
  } catch {
    // Keeps the fallbacks above.
  }
  const data: RootLoaderData = { threads: await fetchThreads(), threadAnalysisMode, features };
  return data;
}

/** What the app shell loads once per navigation: the sidebar's threads and the deployment's surfaces. */
export interface RootLoaderData {
  threads: Thread[];
  threadAnalysisMode: ThreadAnalysisMode;
  features: FeatureFlags;
}

// Framework entry for the app chrome: reads route state, delegates to the pure shell.
function AppLayoutComponent() {
  const { threads, threadAnalysisMode, features } = useRouteLoaderData('root') as RootLoaderData;
  const match = useMatch('/threads/:threadId');
  const location = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const createFetcher = useFetcher();
  const renameFetcher = useFetcher({ key: 'rename-thread' });
  const deleteFetcher = useFetcher({ key: 'delete-thread' });
  const generateTitleFetcher = useFetcher();

  const generatingTitleThreadId = generateTitleFetcher.formData
    ? String(generateTitleFetcher.formData.get('threadId') ?? '')
    : null;

  // One push connection per tab: opened when the app shell mounts, closed
  // when it unmounts. Screens subscribe to the kinds they care about.
  useEffect(() => {
    pushClient.connect();
    return () => pushClient.disconnect();
  }, []);

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
        revalidator.revalidate();
      }),
    [revalidator.revalidate],
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
        t.id === generatingTitleThreadId || t.id === queuedTitlingThreadId
          ? { ...t, title: TITLE_GENERATING_SENTINEL }
          : t,
      );
  }, [threads, pendingDeleteId, generatingTitleThreadId, queuedTitlingThreadId]);

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
      navigationKey={location.key}
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
            // sidebar/info panel to the loading pulse immediately. `forced`
            // tells the backend to title from the thread's first segment
            // instead of its first exchange.
            generateTitleFetcher.submit(
              { threadId: id, forced: 'true' },
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
          memory={features.memory}
          onMemory={() => navigate('/memory')}
          onSettings={() => navigate('/settings')}
        />
      }
      infoPanel={
        <ThreadInfoPanel
          summary={threadSummary}
          threadTitle={activeThreadTitle}
          onRefreshPricing={handleRefreshPricing}
          threadId={currentThreadId ?? undefined}
          memoryCaptureAvailable={features.memory && threadAnalysisMode !== 'off'}
        />
      }
    >
      {/* Keyed by thread so the chat page remounts (fresh useChat state) when switching. */}
      <Outlet
        key={match?.params.threadId ?? 'empty'}
        context={{
          analysisMode: threadAnalysisMode,
          memory: features.memory,
          refreshThreadSummary: handleRefreshThreadSummary,
          // A thread opened outside the sidebar (a handover) joins the list
          // once the navigation has landed.
          openThread: async (id: string) => {
            await navigate(`/threads/${id}`);
            await revalidator.revalidate();
          },
        }}
      />
    </AppShell>
  );
}

export default function AppLayout() {
  return (
    <SessionAuth>
      <AppLayoutComponent />
    </SessionAuth>
  );
}

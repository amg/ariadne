import AppShell from '@/components/layout/AppShell';
import ThreadInfoPanel from '@/components/layout/ThreadInfoPanel';
import ThreadSidebar from '@/components/layout/ThreadSidebar';
import { FEATURE_DEFAULTS, type FeatureFlags, featuresFromServer } from '@/config/features';
import { type ThreadAnalysisMode, fetchConfig, fetchThreads } from '@/services/api';
import { pushClient } from '@/services/push';
import type { RootLoaderData } from '@/types/pages';
import { useEffect } from 'react';
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
import Session, { SessionAuth } from 'supertokens-auth-react/recipe/session';
import { useOptimisticThreads } from './useOptimisticThreads';
import { useThreadSummary } from './useThreadSummary';
import { useThreadTitling } from './useThreadTitling';

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

// Framework entry for the app chrome: reads route state, delegates to the pure shell.
function AppLayoutComponent() {
  const { threads, threadAnalysisMode, features } = useRouteLoaderData('root') as RootLoaderData;
  const match = useMatch('/threads/:threadId');
  const location = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const createFetcher = useFetcher();
  const currentThreadId = match?.params.threadId ?? null;

  // One push connection per tab: opened when the app shell mounts, closed
  // when it unmounts. Screens subscribe to the kinds they care about.
  useEffect(() => {
    pushClient.connect();
    return () => pushClient.disconnect();
  }, []);

  // Whatever push announced while the connection was down (titles, verdicts
  // on the open Thread) is re-read through the loaders once it is back.
  useEffect(() => pushClient.onReconnected(revalidator.revalidate), [revalidator.revalidate]);

  const { titlingThreadIds, regenerateTitle } = useThreadTitling({
    threads,
    revalidate: revalidator.revalidate,
  });
  const { visibleThreads, pendingRename, rename, remove } = useOptimisticThreads({
    threads,
    titlingThreadIds,
  });
  const { summary, refresh, refreshPricing } = useThreadSummary(currentThreadId);

  // The info-panel/chat title follows sidebar state (the loading pulse during
  // in-flight titling, optimistic delete) without any I/O.
  const activeThreadTitle = visibleThreads.find((t) => t.id === currentThreadId)?.title;

  return (
    <AppShell
      navigationKey={location.key}
      sidebar={
        <ThreadSidebar
          threads={visibleThreads}
          activeThreadId={currentThreadId}
          onSelectThread={(id) =>
            // Preserve the query string (e.g. ?mode=analyze) so analysis
            // viewing carries across thread switches.
            navigate({ pathname: `/threads/${id}`, search: location.search, hash: location.hash })
          }
          onNewChat={() => createFetcher.submit(null, { method: 'post', action: '/threads/new' })}
          onRename={rename}
          onRegenerateTitle={regenerateTitle}
          onDelete={remove}
          pendingRename={pendingRename}
          onAbout={() => navigate('/about')}
          memory={features.memory}
          onMemory={() => navigate('/memory')}
          onSettings={() => navigate('/settings')}
        />
      }
      infoPanel={
        <ThreadInfoPanel
          summary={summary}
          threadTitle={activeThreadTitle}
          onRefreshPricing={refreshPricing}
          threadId={currentThreadId ?? undefined}
          memoryCaptureAvailable={features.memory && threadAnalysisMode !== 'off'}
        />
      }
    >
      {/* Keyed by thread so the chat page remounts (fresh useChat state) when switching. */}
      <Outlet
        key={currentThreadId ?? 'empty'}
        context={{
          analysisMode: threadAnalysisMode,
          memory: features.memory,
          refreshThreadSummary: refresh,
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

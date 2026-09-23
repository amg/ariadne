import { ChatController } from '@/components/chat';
import AnalysisTab from '@/components/chat/AnalysisTab';
import { type Message, type ThreadAnalysisMode, fetchMessages } from '@/services/api';
import type { Thread } from '@/services/api';
import { useState } from 'react';
import {
  useLoaderData,
  useOutletContext,
  useRevalidator,
  useRouteLoaderData,
  useSearchParams,
} from 'react-router';

/** Framework glue only: loader + revalidation. The exchange lives in
 *  components/chat/ChatController. See PK "Framework files" policy. */

type LoaderProps = { params: { threadId?: string } };

export async function loader({ params }: LoaderProps) {
  return {
    threadId: params.threadId ?? '',
    messages: params.threadId ? await fetchMessages(params.threadId) : [],
  };
}

/** The center area's two surfaces — bubbles vs the live reading. */
function ThreadDetailTabs({
  analyzing,
  onConversation,
  onAnalyze,
}: {
  analyzing: boolean;
  onConversation: () => void;
  onAnalyze: () => void;
}) {
  const tabClass = (active: boolean) =>
    `rounded-md px-3 py-1 text-sm transition-colors ${
      active
        ? 'bg-muted font-medium text-foreground'
        : 'text-muted-foreground hover:text-foreground'
    }`;
  return (
    <div role="tablist" aria-label="Thread surfaces" className="flex gap-1 border-b px-4 py-2">
      <button
        type="button"
        role="tab"
        aria-selected={!analyzing}
        className={tabClass(!analyzing)}
        onClick={onConversation}
      >
        Conversation
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={analyzing}
        className={tabClass(analyzing)}
        onClick={onAnalyze}
      >
        Analysis
      </button>
    </div>
  );
}

export default function ChatPage() {
  const { threadId, messages: rows } = useLoaderData() as {
    threadId: string;
    messages: Message[];
  };
  const { threads } = useRouteLoaderData('root') as { threads: Thread[] };
  const { analysisMode, generateTitle, refreshThreadSummary } = useOutletContext<{
    analysisMode: ThreadAnalysisMode;
    generateTitle: (id: string) => void;
    refreshThreadSummary: () => Promise<void>;
  }>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [analysisRefreshKey, setAnalysisRefreshKey] = useState(0);

  const title = threads?.find((thread) => thread.id === threadId)?.title;

  // Off = surface gone entirely: no tabs, and a stale ?mode=analyze renders
  // the conversation instead of a hidden page.
  const analysisAllowed = analysisMode !== 'off';
  const analyzing = analysisAllowed && searchParams.get('mode') === 'analyze';

  const setAnalyzing = (next: boolean) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('mode', 'analyze');
    else params.delete('mode');
    setSearchParams(params, { replace: !next });
  };

  const handleSettle = async () => {
    revalidator.revalidate();
    setAnalysisRefreshKey((key) => key + 1);
    // Refresh the right panel (cost, tokens, etc.)
    await refreshThreadSummary();
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {analysisAllowed ? (
        <ThreadDetailTabs
          analyzing={analyzing}
          onConversation={() => setAnalyzing(false)}
          onAnalyze={() => setAnalyzing(true)}
        />
      ) : null}
      {analyzing ? (
        <AnalysisTab
          threadId={threadId}
          refreshKey={analysisRefreshKey}
          onLoaded={() => refreshThreadSummary()}
        />
      ) : (
        <ChatController
          threadId={threadId}
          rows={rows}
          onSettle={handleSettle}
          isNewChat={title === null}
          onGenerateTitle={() => {
            if (title === null) {
              generateTitle(threadId);
            }
          }}
        />
      )}
    </div>
  );
}

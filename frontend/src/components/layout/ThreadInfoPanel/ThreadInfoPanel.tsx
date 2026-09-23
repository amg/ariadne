import {
  DEFAULT_THREAD_TITLE,
  TITLE_GENERATING_SENTINEL,
  type ThreadSummary,
} from '@/services/api';
import { formatCost, formatTokens } from '@/services/utils';
import { Bot, Calendar, Clock, Coins, MessageSquare, RefreshCw, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { CostBreakdown } from './CostBreakdown';
import { ModelRow } from './ModelRow';
import { StatRow } from './StatRow';
import { TokenRow } from './TokenRow';

type Props = {
  summary: ThreadSummary | null;
  threadTitle?: string | null;
  onRefreshPricing?: () => Promise<{ rateLimited?: boolean; retryAfter?: number }>;
};

function useRefreshPricing(onRefreshPricing?: Props['onRefreshPricing']) {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!onRefreshPricing || isRefreshing) return;
    setIsRefreshing(true);
    try {
      await onRefreshPricing();
    } finally {
      setTimeout(() => setIsRefreshing(false), 500);
    }
  };

  return { isRefreshing, handleRefresh };
}

/**
 * Right side panel showing thread statistics and usage info.
 * Always visible in 3-column layout: threads | chat | info
 */
export default function ThreadInfoPanel({ summary, threadTitle, onRefreshPricing }: Props) {
  const { isRefreshing, handleRefresh } = useRefreshPricing(onRefreshPricing);

  if (!summary) {
    return (
      <aside className="flex h-full w-72 shrink-0 flex-col border-l bg-muted/30 p-4 pt-12 nav:pt-4">
        <div className="text-sm text-muted-foreground">Select a thread to view details</div>
      </aside>
    );
  }

  const {
    totalMessages,
    userMessages,
    assistantMessages,
    totalCostUsd,
    cachedCostUsd,
    costBreakdown,
    totalTokens,
    models,
    contextUsage,
    createdAt,
  } = summary;

  const costDisplay = formatCost(totalCostUsd);
  const cachedCostDisplay = formatCost(cachedCostUsd);
  const dateDisplay = new Date(createdAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <aside className="scrollbar-slim flex h-full w-72 shrink-0 flex-col border-l bg-muted/30 p-4 pt-12 nav:pt-4 overflow-y-auto">
      <h2 className="mb-4 text-sm font-semibold text-foreground">Thread Info</h2>

      {/* Thread Title (pulse while auto-titling is in flight) */}
      {threadTitle !== undefined && (
        <div className="mb-4 rounded-md border bg-background p-3">
          {threadTitle === TITLE_GENERATING_SENTINEL ? (
            <span className="inline-block h-4 w-32 animate-pulse rounded bg-foreground/10" />
          ) : (
            <p className="truncate text-sm font-medium text-foreground">
              {threadTitle === null ? DEFAULT_THREAD_TITLE : threadTitle}
            </p>
          )}
        </div>
      )}

      {/* Overview Stats */}
      <div className="mb-4 space-y-3">
        <StatRow
          icon={MessageSquare}
          label="Messages"
          value={`${totalMessages} (${userMessages} user, ${assistantMessages} assistant)`}
        />
        <StatRow icon={Calendar} label="Created" value={dateDisplay} />
      </div>

      {/* Cost */}
      <div className="mb-4 rounded-md border bg-background p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
          <Coins className="h-4 w-4 text-amber-500" />
          Total Cost
        </div>
        <p className="text-lg font-bold text-foreground">{costDisplay ?? '—'}</p>
        {costBreakdown && <CostBreakdown breakdown={costBreakdown} />}
        {cachedCostUsd && Number.parseFloat(cachedCostUsd) > 0 && (
          <p className="mt-1 text-xs text-green-600" title="Savings from cached tokens">
            Cached: {cachedCostDisplay} saved
          </p>
        )}
      </div>

      {/* Token Usage — chat model only: the analyzer pipeline spends are cost-only */}
      <div className="mb-4 rounded-md border bg-background p-3">
        <div
          className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground"
          title="Token counts from the main chat model. Analyzer steps (embedding, rewrite, judgement) record cost only, so they are not included here."
        >
          <TrendingUp className="h-4 w-4 text-blue-500" />
          Token Usage
          <span className="font-normal text-muted-foreground">(chat model)</span>
        </div>
        <div className="space-y-1 text-xs">
          <TokenRow label="Prompt" value={formatTokens(totalTokens.prompt)} />
          <TokenRow label="Completion" value={formatTokens(totalTokens.completion)} />
          <TokenRow label="Cached" value={formatTokens(totalTokens.cached)} />
          <TokenRow label="Reasoning" value={formatTokens(totalTokens.reasoning)} />
          <div className="mt-2 border-t pt-2">
            <TokenRow label="Total" value={formatTokens(totalTokens.total)} bold />
          </div>
        </div>
      </div>

      {/* Context Window */}
      <div className="mb-4 rounded-md border bg-background p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
          <Clock className="h-4 w-4 text-green-500" />
          Context Usage
        </div>
        {contextUsage.limit !== null ? (
          <>
            <div className="mb-1 text-xs text-muted-foreground">
              {formatTokens(contextUsage.used)} / {formatTokens(contextUsage.limit)} tokens
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-green-500 transition-all"
                style={{ width: `${Math.min(contextUsage.percentage ?? 0, 100)}%` }}
              />
            </div>
            <p className="mt-1 text-xs font-medium text-green-600">
              {contextUsage.percentage?.toFixed(1)}% used
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Context limit unavailable</p>
        )}
      </div>

      {/* Models with pricing and refresh button */}
      <div className="rounded-md border bg-background p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Bot className="h-4 w-4 text-purple-500" />
            Models
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing || models.length === 0}
            title="Refresh model pricing from provider"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {models.length > 0 ? (
          models.map((model) => <ModelRow key={model.modelId} model={model} />)
        ) : (
          <p className="text-xs text-muted-foreground">No model data</p>
        )}
      </div>
    </aside>
  );
}

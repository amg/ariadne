import type { ThreadSummary } from '@/services/api';
import { formatCost, formatTokens } from '@/services/utils';
import { Bot, Calendar, Clock, Coins, MessageSquare, RefreshCw, TrendingUp } from 'lucide-react';
import { useEffect, useState } from 'react';

type Props = {
  summary: ThreadSummary | null;
  threadTitle?: string;
  onRefreshPricing?: () => void;
};

/**
 * Right side panel showing thread statistics and usage info.
 * Always visible in 3-column layout: threads | chat | info
 */
export default function ThreadInfoPanel({ summary, threadTitle, onRefreshPricing }: Props) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [retryAfter, setRetryAfter] = useState(0);

  // Countdown timer for rate limit
  useEffect(() => {
    if (!rateLimited || retryAfter <= 0) return;

    const timer = setInterval(() => {
      setRetryAfter((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [rateLimited, retryAfter]);

  // Reset rate limit state when retryAfter reaches 0
  useEffect(() => {
    if (rateLimited && retryAfter <= 0) {
      setRateLimited(false);
    }
  }, [rateLimited, retryAfter]);

  const handleRefreshWithRateLimit = async () => {
    if (!onRefreshPricing || isRefreshing || rateLimited) return;
    setIsRefreshing(true);
    try {
      const result = await onRefreshPricing();
      if (result.rateLimited) {
        setRateLimited(true);
        setRetryAfter(result.retryAfter ?? 60);
      }
    } finally {
      setTimeout(() => setIsRefreshing(false), 500);
    }
  };

  if (!summary) {
    return (
      <aside className="flex w-72 shrink-0 flex-col border-l bg-muted/30 p-4">
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
    totalTokens,
    primaryModel,
    primaryModelPricing,
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

  // Format pricing per million tokens
  const inputPrice = primaryModelPricing?.input_price_per_million;
  const outputPrice = primaryModelPricing?.output_price_per_million;
  const cachedPrice = primaryModelPricing?.cached_price_per_million;
  const cachedRate = primaryModelPricing?.cached_rate_multiplier;
  const formatPrice = (price: number | null) => {
    if (price === null) return '—';
    if (price < 0.01) return `$${price.toFixed(4)}`;
    return `$${price.toFixed(2)}`;
  };
  const formatRate = (rate: number | null) => {
    if (rate === null) return '—';
    return `${(rate * 100).toFixed(0)}%`;
  };

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l bg-muted/30 p-4">
      <h2 className="mb-4 text-sm font-semibold text-foreground">Thread Info</h2>

      {/* Thread Title */}
      {threadTitle && (
        <div className="mb-4 rounded-md border bg-background p-3">
          <p className="truncate text-sm font-medium text-foreground">{threadTitle}</p>
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
        {cachedCostUsd && Number.parseFloat(cachedCostUsd) > 0 && (
          <p className="mt-1 text-xs text-green-600" title="Savings from cached tokens">
            Cached: {cachedCostDisplay} saved
          </p>
        )}
      </div>

      {/* Token Usage */}
      <div className="mb-4 rounded-md border bg-background p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
          <TrendingUp className="h-4 w-4 text-blue-500" />
          Token Usage
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

      {/* Primary Model with Pricing and Refresh Button */}
      <div className="rounded-md border bg-background p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Bot className="h-4 w-4 text-purple-500" />
            Primary Model
          </div>
          <button
            type="button"
            onClick={handleRefreshWithRateLimit}
            disabled={isRefreshing || rateLimited || !primaryModel}
            title={
              rateLimited
                ? `Wait ${retryAfter}s before refreshing`
                : 'Refresh model pricing from provider'
            }
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {primaryModel ? (
          <>
            <p className="truncate text-xs text-foreground" title={primaryModel}>
              {primaryModel}
            </p>
            {primaryModelPricing && (
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                <div className="flex items-center gap-3">
                  <span title="Input price per million tokens">
                    <span className="font-medium text-foreground">Input:</span>{' '}
                    {formatPrice(inputPrice)}/1M
                  </span>
                  <span title="Output price per million tokens">
                    <span className="font-medium text-foreground">Output:</span>{' '}
                    {formatPrice(outputPrice)}/1M
                  </span>
                </div>
                {primaryModelPricing.cached_price_per_million !== null && (
                  <div className="flex items-center gap-3">
                    <span title="Cached token price per million tokens">
                      <span className="font-medium text-foreground">Cached:</span>{' '}
                      {formatPrice(cachedPrice)}/1M
                    </span>
                    <span title="Cached token rate (multiplier of input price)">
                      <span className="font-medium text-foreground">Rate:</span>{' '}
                      {formatRate(cachedRate)} of input
                    </span>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">No model data</p>
        )}
        {rateLimited && (
          <p className="mt-2 text-xs text-amber-500">Wait {retryAfter}s before refreshing</p>
        )}
      </div>
    </aside>
  );
}

function StatRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

function TokenRow({
  label,
  value,
  bold,
}: {
  label: string;
  value: string | null;
  bold?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}:</span>
      <span className={bold ? 'font-bold text-foreground' : 'font-medium text-foreground'}>
        {value ?? '—'}
      </span>
    </div>
  );
}

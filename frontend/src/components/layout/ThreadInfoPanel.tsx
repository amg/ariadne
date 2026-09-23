import {
  DEFAULT_THREAD_TITLE,
  TITLE_GENERATING_SENTINEL,
  type ThreadSummary,
} from '@/services/api';
import { formatCost, formatTokens } from '@/services/utils';
import { Bot, Calendar, Clock, Coins, MessageSquare, RefreshCw, TrendingUp } from 'lucide-react';
import { useState } from 'react';

type ModelInfo = ThreadSummary['models'][number];
type ModelRole = ModelInfo['roles'][number];

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
 * Formats model pricing for display
 */
function ModelPricing({ pricing }: { pricing: NonNullable<ModelInfo['pricing']> }) {
  const formatPrice = (price: number | null | undefined) =>
    price == null ? '—' : price < 0.01 ? `$${price.toFixed(4)}` : `$${price.toFixed(2)}`;

  const savingsPct =
    pricing.cachedRateMultiplier != null
      ? Math.round((1 - pricing.cachedRateMultiplier) * 100)
      : null;

  return (
    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
      <div className="flex items-center gap-3">
        <span title="Input price per million tokens">
          <span className="font-medium text-foreground">Input:</span>{' '}
          {formatPrice(pricing.inputPricePerMillion)}/1M
        </span>
        <span title="Output price per million tokens">
          <span className="font-medium text-foreground">Output:</span>{' '}
          {formatPrice(pricing.outputPricePerMillion)}/1M
        </span>
      </div>
      {pricing.cachedPricePerMillion !== null && (
        <div
          title={`Price per million cached input tokens${savingsPct != null ? ` — saves ${savingsPct}% vs input price` : ''}`}
        >
          <span className="font-medium text-foreground">Cache input:</span>{' '}
          {formatPrice(pricing.cachedPricePerMillion)}/1M
          {savingsPct != null && <span className="text-green-600"> · saves {savingsPct}%</span>}
        </div>
      )}
    </div>
  );
}

/** Generated labels for pipeline roles the model serves. */
const ROLE_LABELS: Record<ModelRole, string> = {
  chat: 'Chat',
  embedding: 'Embedding',
  rewrite: 'Rewrite',
  judge: 'Judgement',
};

/** One model card: role labels, model id, pricing. */
function ModelRow({ model }: { model: ModelInfo }) {
  const roles = model.roles.map((role) => ROLE_LABELS[role]).join(' · ');
  return (
    <div className="border-t py-2 first:border-t-0 first:pt-0 last:pb-0">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {roles}
      </p>
      <p className="truncate text-xs text-foreground" title={model.modelId}>
        {model.modelId}
      </p>
      {model.pricing ? (
        <ModelPricing pricing={model.pricing} />
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">No pricing data</p>
      )}
    </div>
  );
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

/** Cost categories for the Includes breakdown. */
const CHAT_COST_ROW = {
  field: 'chat',
  label: 'Chat',
  title: 'Conversation token cost from the chat model',
} as const;

/** Analyzer categories are omitted from the list when their spend is zero. */
const ANALYZER_COST_ROWS = [
  {
    field: 'embedding',
    label: 'Embeddings',
    title: 'Thread analyzer: embedding arriving user messages',
  },
  {
    field: 'rewrite',
    label: 'Rewrite',
    title: 'Thread analyzer: expanding context-dependent follow-ups',
  },
  {
    field: 'judge',
    label: 'Judgement',
    title: 'Thread analyzer: classifying context dependence',
  },
] as const;

type CostRow = typeof CHAT_COST_ROW | (typeof ANALYZER_COST_ROWS)[number];

/** Share of the thread's total spend; '—' when total spend is zero. */
function formatShare(valueUsd: string, totalUsd: number): string {
  if (totalUsd <= 0) return '—';
  const pct = (Number.parseFloat(valueUsd) / totalUsd) * 100;
  if (pct <= 0) return '0%';
  if (pct < 0.1) return '<0.1%';
  return `${pct.toFixed(1)}%`;
}

/** One breakdown row: label, share of the total, USD amount. */
function BreakdownRow({
  row,
  valueUsd,
  totalUsd,
}: { row: CostRow; valueUsd: string; totalUsd: number }) {
  return (
    <>
      <span className="truncate text-muted-foreground" title={row.title}>
        {row.label}:
      </span>
      <span className="text-right font-medium tabular-nums text-foreground">
        {formatShare(valueUsd, totalUsd)}
      </span>
      <span className="text-right tabular-nums text-muted-foreground">
        {formatCost(valueUsd) ?? '$0.00'}
      </span>
    </>
  );
}

/** "Includes" list under the total: label, share of the total, cost per row. */
function CostBreakdown({ breakdown }: { breakdown: ThreadSummary['costBreakdown'] }) {
  const rows = [
    CHAT_COST_ROW,
    ...ANALYZER_COST_ROWS.filter((row) => Number.parseFloat(breakdown[row.field]) > 0),
  ];
  const totalUsd =
    Number.parseFloat(breakdown.chat) +
    Number.parseFloat(breakdown.embedding) +
    Number.parseFloat(breakdown.rewrite) +
    Number.parseFloat(breakdown.judge);

  return (
    <div className="mt-2 border-t pt-2 text-xs">
      <p className="mb-1 text-muted-foreground">Includes:</p>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 gap-y-1">
        {rows.map((row) => (
          <BreakdownRow
            key={row.field}
            row={row}
            valueUsd={breakdown[row.field]}
            totalUsd={totalUsd}
          />
        ))}
      </div>
    </div>
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
  title,
}: {
  label: string;
  value: string | null;
  bold?: boolean;
  title?: string;
}) {
  return (
    <div className="flex justify-between" title={title}>
      <span className="text-muted-foreground">{label}:</span>
      <span className={bold ? 'font-bold text-foreground' : 'font-medium text-foreground'}>
        {value ?? '—'}
      </span>
    </div>
  );
}

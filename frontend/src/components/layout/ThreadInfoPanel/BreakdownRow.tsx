import { formatCost } from '@/services/utils';

export const CHAT_COST_ROW = {
  field: 'chat',
  label: 'Chat',
  title: 'Conversation token cost from the chat model',
} as const;

export const ANALYZER_COST_ROWS = [
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

function formatShare(valueUsd: string, totalUsd: number): string {
  if (totalUsd <= 0) return '—';
  const pct = (Number.parseFloat(valueUsd) / totalUsd) * 100;
  if (pct <= 0) return '0%';
  if (pct < 0.1) return '<0.1%';
  return `${pct.toFixed(1)}%`;
}

export function BreakdownRow({
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

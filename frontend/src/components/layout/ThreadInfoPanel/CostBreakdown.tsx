import type { ThreadSummary } from '@/services/api';
import { ANALYZER_COST_ROWS, BreakdownRow, CHAT_COST_ROW } from './BreakdownRow';

/** "Includes" list under the total: label, share of the total, cost per row. */
export function CostBreakdown({ breakdown }: { breakdown: ThreadSummary['costBreakdown'] }) {
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

import type { ExpandOutcome, LiveAnalysisPoint, LiveAnalysisView } from '@/services/api';
import { CircleAlert, PencilSparkles } from 'lucide-react';
import { Fragment } from 'react';

/** Human reason shown on hover when an arrival's rewrite try failed. */
const EXPAND_FAILURE_LABEL: Partial<Record<ExpandOutcome, string>> = {
  failed_refused: 'the rewrite model refused',
  failed_quality: 'the rewrite failed quality control',
  failed_inference: 'the rewrite call failed',
  failed: 'the rewrite was unusable',
};

function expandFailureTitle(outcome: ExpandOutcome) {
  const label = EXPAND_FAILURE_LABEL[outcome] ?? 'the rewrite did not land';
  return `Rewrite ${outcome}: ${label}. The original message was embedded instead.`;
}

export function SegmentTable({ view }: { view: LiveAnalysisView }) {
  if (view.segments.length === 0) return null;
  const arrivalsBySegment = new Map<number, LiveAnalysisPoint[]>();
  for (const point of view.points) {
    const rows = arrivalsBySegment.get(point.segmentIndex) ?? [];
    rows.push(point);
    arrivalsBySegment.set(point.segmentIndex, rows);
  }
  for (const rows of arrivalsBySegment.values()) {
    rows.sort((a, b) => a.turnNumber - b.turnNumber);
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-2 py-1.5">Turn</th>
            <th className="px-2 py-1.5">Arrival message</th>
          </tr>
        </thead>
        <tbody>
          {view.segments.map((segment) => {
            const arrivals = arrivalsBySegment.get(segment.index) ?? [];
            return (
              <Fragment key={segment.segmentId}>
                <tr className="border-b border-border/50 bg-card/40">
                  <td colSpan={2} className="px-2 py-1.5 text-xs text-muted-foreground">
                    Segment #{segment.index} ·{' '}
                    {segment.closedByChannel !== null ? (
                      <span className="text-purple-400">
                        {segment.closedByChannel === 'immediate'
                          ? 'fast topic change'
                          : 'slow topic drift'}
                      </span>
                    ) : (
                      <span className="text-emerald-400">open</span>
                    )}
                  </td>
                </tr>
                {arrivals.map((point) => {
                  const rewritten = point.rewrittenText;
                  const rewriteFailed =
                    point.expandOutcome !== null && point.expandOutcome !== 'accepted';
                  return (
                    <tr key={point.messageId} className="border-b border-border/50">
                      <td
                        className="px-2 py-1.5 align-top tabular-nums text-muted-foreground"
                        title={
                          point.verdict === 'muted'
                            ? `Turn ${point.turnNumber} · muted (ledger warming up)`
                            : `Turn ${point.turnNumber}`
                        }
                      >
                        {point.turnNumber}
                      </td>
                      <td className="px-2 py-1.5" title={rewritten ?? point.messageText}>
                        <span className="flex max-w-[420px] items-center">
                          {rewriteFailed && point.expandOutcome !== null && (
                            <span
                              className="mr-1 shrink-0 cursor-default"
                              title={expandFailureTitle(point.expandOutcome)}
                            >
                              <CircleAlert className="h-3 w-3 text-rose-400" aria-hidden />
                            </span>
                          )}
                          {rewritten !== null && (
                            <span className="mr-1 shrink-0 cursor-default" title={rewritten}>
                              <PencilSparkles className="h-3 w-3 text-amber-400" aria-hidden />
                            </span>
                          )}
                          <span className="min-w-0 truncate">{point.messageText}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

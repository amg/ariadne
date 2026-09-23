import { type LiveAnalysisView, fetchThreadAnalysis } from '@/services/api';
import { useEffect, useRef, useState } from 'react';
import { AnalysisSpinner } from './AnalysisSpinner';
import { DriftChart } from './DriftChart';
import { Legend } from './Legend';
import { SegmentTable } from './SegmentTable';
import { ZChart } from './ZChart';
import { buildChartModel } from './model';

export default function AnalysisTab({
  threadId,
  refreshKey,
  onLoaded,
}: { threadId: string; refreshKey?: number; onLoaded?: () => void }) {
  const [view, setView] = useState<LiveAnalysisView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a refetch trigger, not a read value
  useEffect(() => {
    let stale = false;
    setView(null);
    setError(null);
    fetchThreadAnalysis(threadId)
      .then((loaded) => {
        if (stale) return;
        setView(loaded);
        onLoadedRef.current?.();
      })
      .catch((err: unknown) => {
        if (!stale) setError(err instanceof Error ? err.message : 'Failed to load the analysis.');
      });
    return () => {
      stale = true;
    };
  }, [threadId, refreshKey]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-red-400">
        {error}
      </div>
    );
  }
  if (!view || view.pending) return <AnalysisSpinner />;
  if (view.points.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        No arrivals judged yet — send a message and the live reading will fill in here.
      </div>
    );
  }

  const model = buildChartModel(view);
  const fires = view.points.filter((point) => point.verdict === 'fire').length;

  return (
    <div className="scrollbar-slim flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full min-w-0 max-w-[900px] py-4 flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Live reading</h2>
          <p className="text-xs text-muted-foreground">
            {view.points.length} judged arrivals · {view.segments.length} segment
            {view.segments.length === 1 ? '' : 's'} · {fires} fire{fires === 1 ? '' : 's'} —
            persisted as they were judged (embedding {view.params.embeddingModelId})
          </p>
        </header>
        <Legend />
        <div className="rounded-lg border border-border bg-card/40 p-3">
          <DriftChart model={model} />
        </div>
        <div className="rounded-lg border border-border bg-card/40 p-3">
          <ZChart model={model} />
        </div>
        <SegmentTable view={view} />
      </div>
    </div>
  );
}

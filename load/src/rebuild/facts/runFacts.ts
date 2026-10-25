import type { RunEvent } from '../../records/index.ts';
import { cacheEcpuCapOrNull } from '../runData/index.ts';
import type { RunData, RunFacts } from '../types.ts';
import { chatCountsOf } from './chats.ts';
import { runFiguresOf } from './figures.ts';
import { findGaps } from './gaps.ts';
import { guardStopOf } from './guardStop.ts';
import { holdFactsOf } from './hold.ts';
import { markersOf } from './markers.ts';
import { summarizeSlices } from './slices.ts';
import { summarize } from './summary.ts';
import { timelineOf } from './timeline.ts';

/** The facts of a run, from its records. */
export function runFactsOf(data: RunData): RunFacts {
  const { manifest } = data;
  const ended = data.events?.find(
    (event): event is Extract<RunEvent, { kind: 'run-ended' }> => event.kind === 'run-ended',
  );
  return {
    run: {
      runId: manifest.runId,
      step: manifest.step,
      target: manifest.target,
      loadPath: manifest.loadPath,
      startedAt: manifest.startedAt,
      endedAt: manifest.endedAt,
      seal: manifest.seal,
      limits: manifest.limits,
      cacheEcpuCap: cacheEcpuCapOrNull(manifest),
    },
    outcome: ended?.outcome ?? null,
    slices: summarizeSlices(data),
    guardStop: guardStopOf(data),
    gaps: findGaps(data),
    trouble: data.trouble,
    figures: runFiguresOf(data),
    hold: holdFactsOf(data),
    chats: chatCountsOf(data),
    requestLinesWhole: data.slices.every(({ requests }) => requests !== null),
    summary: summarize(data),
    timeline: timelineOf(data),
    markers: markersOf(data),
  };
}

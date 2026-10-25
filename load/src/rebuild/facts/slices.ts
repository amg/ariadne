import { isChat, lastUserOf } from '../../records/index.ts';
import { isInsideAny, windowsInMs } from '../moments.ts';
import { isCutAndReopenedIn } from '../runData/index.ts';
import type { RunData, SliceSummary } from '../types.ts';
import { secondsBetween } from './gaps.ts';

/** Every slice of the run, in generator order. */
export function summarizeSlices(data: Pick<RunData, 'slices'>): SliceSummary[] {
  const reopened = isCutAndReopenedIn(data);
  return [...data.slices]
    .sort((a, b) => a.slice.generator - b.slice.generator)
    .map(({ slice, requests }) => {
      const lines = requests ?? [];
      return {
        generator: slice.generator,
        firstUser: slice.firstUser,
        lastUser: lastUserOf(slice),
        requests: lines.length,
        failedRequests: lines.filter((line) => line.outcome === 'failed' && !reopened(line)).length,
        chatsStreamed: lines.filter((line) => isChat(line) && line.outcome === 'streamed').length,
        down: slice.down,
        downSeconds: slice.down.reduce(
          (total, window) => total + secondsBetween(window.from, window.to),
          0,
        ),
      };
    });
}

/** Tells whether a moment falls inside any of the windows. */
export function insideAnyOf(
  windows: readonly { from: string; to: string }[],
): (moment: string) => boolean {
  const inMs = windowsInMs(windows);
  return (moment) => isInsideAny(inMs, Date.parse(moment));
}

/** Every window any slice was down. */
export function downWindowsOf(data: Pick<RunData, 'manifest'>) {
  return data.manifest.slices.flatMap(({ down }) => down);
}

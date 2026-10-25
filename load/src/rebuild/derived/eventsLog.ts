import type { TimelineEntry } from '../types.ts';

/** The run's timeline as text, one line a moment, oldest first. */
export function eventsLog(timeline: readonly TimelineEntry[]) {
  return `${timeline.map((entry) => `${entry.at}  ${entry.text}`).join('\n')}\n`;
}

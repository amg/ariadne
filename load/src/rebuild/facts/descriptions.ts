import { type AwsEvent, type RunEvent, formattedUserRange } from '../../records/index.ts';
import { compareText } from '../numbers.ts';

/** What happened in the run, in one line. */
export function describeEvent(event: RunEvent) {
  switch (event.kind) {
    case 'run-started':
      return 'run started';
    case 'run-ended':
      return `run ended (${event.outcome})`;
    case 'process-started':
      return `${event.name} started (${event.task})`;
    case 'process-stopped':
      return `${event.name} stopped`;
    case 'generator-launched':
      return `generator ${event.generator} launched on ${event.task} (${event.spot ? 'spot' : 'on-demand'}) for users ${formattedUserRange(event)}`;
    case 'generator-stopped':
      return `generator ${event.generator} stopped (${event.reason}${event.detail === null ? '' : `: ${event.detail}`})`;
    case 'guard-tripped':
      return `guard line ${event.line} crossed: ${event.message}`;
  }
}

/** What AWS recorded, in one line: where it came from, the service by its label where it is one, and what it said. */
export function describeAwsEvent(event: AwsEvent, serviceLabels: ReadonlyMap<string, string>) {
  return `${event.source} ${serviceLabels.get(event.resource) ?? event.resource}: ${event.summary}`;
}

/** Orders entries by time, keeping the order they were given for entries at the same moment. */
export function inTimeOrder<T extends { at: string }>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => compareText(a.entry.at, b.entry.at) || a.index - b.index)
    .map(({ entry }) => entry);
}

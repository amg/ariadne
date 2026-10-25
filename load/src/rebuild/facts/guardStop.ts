import type { RunEvent } from '../../records/index.ts';
import { runWindowOf } from '../runData/index.ts';
import type { RunData } from '../types.ts';

/** The guard line that stopped the run; null when no line did. */
export function guardStopOf(data: RunData) {
  const tripped = data.events?.find(
    (event): event is Extract<RunEvent, { kind: 'guard-tripped' }> =>
      event.kind === 'guard-tripped',
  );
  if (tripped === undefined) return null;
  const plannedEnds = data.manifest.slices.flatMap(({ hold }) => hold?.to ?? []);
  const to = [runWindowOf(data).to, ...plannedEnds].reduce((latest, at) =>
    at > latest ? at : latest,
  );
  return {
    line: tripped.line,
    message: tripped.message,
    observed: tripped.observed,
    limit: tripped.limit,
    from: tripped.at,
    to: to < tripped.at ? tripped.at : to,
  };
}

import type { AppStateLine } from '../../records/index.ts';
import { compareText } from '../numbers.ts';

/** What a copy that did not name itself is called. */
const UNNAMED = 'unnamed';

/** How much of a copy's own name its label keeps: enough to tell the copies of one raise apart. */
const NAME_KEPT = 8;

/**
 * What a copy of the backend did, from what its state lines measure: an
 * API copy counts push streams, a worker copy counts job slots, and a copy
 * that does both is the whole backend in one process.
 */
function roleOf(lines: readonly AppStateLine[]): string {
  const pushes = lines.some((line) => line.pushStreamsOpen !== null);
  const jobs = lines.some((line) => line.workerSlots !== null);
  if (pushes && jobs) return 'backend';
  if (pushes) return 'api';
  return jobs ? 'worker' : 'copy';
}

/**
 * A label for each copy that wrote a state line, by the copy's name: its
 * role and the start of its name, such as `api-8536ff1a`. Copies whose
 * names start alike keep their whole names, so no two share a label. The
 * labels come in sorted order.
 */
export function copyLabelsOf(states: readonly AppStateLine[]): ReadonlyMap<string | null, string> {
  const byCopy = new Map<string | null, AppStateLine[]>();
  for (const state of states) {
    const own = byCopy.get(state.copy);
    if (own === undefined) byCopy.set(state.copy, [state]);
    else own.push(state);
  }
  const shortOf = (copy: string | null) => (copy ?? UNNAMED).slice(0, NAME_KEPT);
  const sharesItsStart = (copy: string | null) =>
    [...byCopy.keys()].filter((other) => shortOf(other) === shortOf(copy)).length > 1;
  const labels = [...byCopy].map(([copy, lines]) => {
    const name = sharesItsStart(copy) ? (copy ?? UNNAMED) : shortOf(copy);
    return [copy, `${roleOf(lines)}-${name}`] as const;
  });
  return new Map(labels.sort(([, a], [, b]) => compareText(a, b)));
}

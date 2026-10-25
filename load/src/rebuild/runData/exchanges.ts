import { type ExchangeLine, judgedVerdictOrNull } from '../../records/index.ts';

/**
 * How many of the Drift gate's verdicts in these exchanges were a wait
 * that hit its limit, out of all it judged. A verdict that an earlier request
 * already judged is in neither count.
 */
export function gateWaitCounts(lines: readonly ExchangeLine[]) {
  return {
    atLimit: lines.filter(
      (line) => line.outcome === 'gate-pending' && judgedVerdictOrNull(line) !== null,
    ).length,
    judged: lines.filter((line) => judgedVerdictOrNull(line) !== null).length,
  };
}

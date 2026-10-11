import { stepNamed } from '../config/steps.ts';
import { worstCaseOf } from '../lib/worstCase.ts';

/**
 * Prints the worst-case USD of one raise or one load run of a step:
 *   tsx bin/worstCase.ts <step> raise|load
 */
const [stepName, kind] = process.argv.slice(2);
if (stepName === undefined || (kind !== 'raise' && kind !== 'load')) {
  console.error('usage: worstCase.ts <step> raise|load');
  process.exit(2);
}

const worstCase = worstCaseOf(stepNamed(stepName));
console.log(kind === 'raise' ? worstCase.raiseUsd : worstCase.loadUsd);

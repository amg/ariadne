import { stepNamed } from '../config/steps.ts';
import { checkQuotas } from '../lib/quotas.ts';

/**
 * Refuses a step whose vCPUs do not fit the account's Fargate quotas, saying
 * which quota and by how much. Exits with 1 when the step does not fit:
 *   tsx bin/quotaCheck.ts <step> <On-Demand vCPU quota> <Spot vCPU quota>
 */
const [stepName, onDemandText = '', spotText = ''] = process.argv.slice(2);
const quotas = { onDemand: Number.parseFloat(onDemandText), spot: Number.parseFloat(spotText) };
if (stepName === undefined || Number.isNaN(quotas.onDemand) || Number.isNaN(quotas.spot)) {
  console.error('usage: quotaCheck.ts <step> <On-Demand vCPU quota> <Spot vCPU quota>');
  process.exit(2);
}

const verdict = checkQuotas(stepNamed(stepName), quotas);
if (!verdict.fits) {
  console.error(verdict.message);
  process.exit(1);
}

import { type DeployPolicy, type ServiceConfig, type Step, maxTasksOf } from '../config/steps.ts';

/** Fargate vCPUs, by the kind of capacity that runs them: what a step needs, or what an account allows. */
type FargateVcpus = {
  onDemand: number;
  spot: number;
};

const CPU_UNITS_PER_VCPU = 1024;

/** Whether a step fits its quotas, and when it does not, the sentence that says what to raise. */
type QuotaVerdict = { fits: true } | { fits: false; message: string };

/**
 * The most Fargate vCPUs a raise of the step can hold at once. The app's
 * services count at their ceiling, plus the extra tasks the step's deploy
 * policy lets run beside them. The generators count at their number, on
 * Spot when the step runs them there and On-Demand when it does not.
 */
export function vcpuNeedOf(step: Step) {
  const services = Object.values(step.services);
  const generators = step.load.generators * vcpusOf(step.load.generator);
  return {
    onDemand:
      sum(services.map((service) => vcpusDuringDeploy(service, step.deploy))) +
      (step.load.spot ? 0 : generators),
    spot: step.load.spot ? generators : 0,
  };
}

/**
 * Whether a step fits the account's quotas. The message names each quota
 * the step overruns, with the vCPUs it needs and the vCPUs the account allows.
 */
export function checkQuotas(step: Step, quotas: FargateVcpus): QuotaVerdict {
  const need = vcpuNeedOf(step);
  const overruns = [
    { capacity: 'On-Demand', need: need.onDemand, quota: quotas.onDemand },
    { capacity: 'Spot', need: need.spot, quota: quotas.spot },
  ].filter((line) => line.need > line.quota);
  if (overruns.length === 0) return { fits: true };
  const lines = overruns.map(
    (line) =>
      `${line.capacity} needs ${vcpuText(line.need)} vCPU and the account's Fargate ${line.capacity} vCPU quota is ${vcpuText(line.quota)}`,
  );
  return {
    fits: false,
    message: `Step ${step.name} does not fit the account's Fargate quotas: ${lines.join('; ')}. Request a higher quota, or choose a smaller step.`,
  };
}

function vcpusOf(size: Pick<ServiceConfig, 'cpu'>) {
  return size.cpu / CPU_UNITS_PER_VCPU;
}

/** A service at the most tasks it can run, with the extra tasks a deploy starts beside them. */
function vcpusDuringDeploy(service: ServiceConfig, deploy: DeployPolicy) {
  const tasks = Math.ceil((maxTasksOf(service) * deploy.maxHealthyPercent) / 100);
  return tasks * vcpusOf(service);
}

function vcpuText(vcpus: number) {
  return Number.isInteger(vcpus) ? String(vcpus) : vcpus.toFixed(2).replace(/\.?0+$/, '');
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

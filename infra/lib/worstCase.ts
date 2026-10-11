import { SAFETY_NET } from '../config/names.ts';
import { HOURS_PER_MONTH, PRICES } from '../config/prices.ts';
import type { ServiceSize, Step } from '../config/steps.ts';

/** Interface endpoints the app network keeps, each in both availability zones. */
export const INTERFACE_ENDPOINT_COUNT = 7;
const AVAILABILITY_ZONES = 2;

/** One load balancer capacity unit covers about 3,000 open connections. */
const CONNECTIONS_PER_LCU = 3_000;

/**
 * The most a raise or a load run can cost before the safety net deletes
 * it. AWS billing lags by hours, so cost is bounded by time instead:
 * capacity-priced items run at most as long as their stack may live, and
 * usage-priced items only accrue under load, which lives at most an hour.
 */
export type WorstCase = {
  /** Everything the app stack holds, for as long as it may live. */
  raiseUsd: number;
  /** Load generators plus every usage-priced item at its ceiling, for as long as load may live. */
  loadUsd: number;
};

export function worstCaseOf(step: Step): WorstCase {
  const appHours = SAFETY_NET.appMinutes / 60;
  const loadHours = SAFETY_NET.loadMinutes / 60;
  return {
    raiseUsd: round(appCapacityPerHour(step) * appHours),
    loadUsd: round((generatorsPerHour(step) + usageCeilingPerHour(step)) * loadHours),
  };
}

function appCapacityPerHour(step: Step): number {
  const { api, worker, auth, mock, web } = step.services;
  const services = [api, worker, auth, mock, web];
  return (
    sum(services.map(fargatePerHour)) +
    databasePerHour(step) +
    PRICES.loadBalancer.perHour +
    INTERFACE_ENDPOINT_COUNT * AVAILABILITY_ZONES * PRICES.interfaceEndpointPerAzHour +
    PRICES.bastionPerHour
  );
}

function databasePerHour(step: Step): number {
  const instance = PRICES.rdsInstancePerHour[step.database.instanceClass];
  if (instance === undefined) {
    throw new Error(`No price for ${step.database.instanceClass}; add it to config/prices.ts`);
  }
  const storage = (step.database.storageGiB * PRICES.rdsGp3PerGbMonth) / HOURS_PER_MONTH;
  return instance + storage;
}

function usageCeilingPerHour(step: Step): number {
  const lcus = Math.max(1, (step.load.users / CONNECTIONS_PER_LCU) * 1.5);
  const cacheEcpuMillions = (step.cache.maxEcpuPerSecond * 3_600) / 1_000_000;
  return (
    lcus * PRICES.loadBalancer.perLcuHour +
    step.cache.maxStorageGb * PRICES.redisServerless.perGbHour +
    cacheEcpuMillions * PRICES.redisServerless.perMillionEcpu +
    step.load.egressGbPerHour * PRICES.egressPerGb +
    step.load.logsGbPerHour * PRICES.logsIngestPerGb
  );
}

function generatorsPerHour(step: Step): number {
  return step.load.generators * fargatePerHour({ ...step.load.generator, count: 1 });
}

function fargatePerHour(size: ServiceSize): number {
  const perTask =
    (size.cpu / 1024) * PRICES.fargate.perVcpuHour +
    (size.memoryMiB / 1024) * PRICES.fargate.perGbHour;
  return size.count * perTask;
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
const round = (usd: number): number => Math.ceil(usd * 100) / 100;

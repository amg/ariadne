import { SAFETY_NET } from '../config/names.ts';
import { HOURS_PER_MONTH, PRICES } from '../config/prices.ts';
import { type ServiceConfig, type Step, maxTasksOf } from '../config/steps.ts';

/** Interface endpoints the app network keeps, each in both availability zones. */
export const INTERFACE_ENDPOINT_COUNT = 7;
const AVAILABILITY_ZONES = 2;

/** One load balancer capacity unit covers about 3,000 open connections. */
const CONNECTIONS_PER_LCU = 3_000;

export function worstCaseOf(step: Step) {
  const appHours = SAFETY_NET.appMinutes / 60;
  const loadHours = SAFETY_NET.loadMinutes / 60;
  return {
    raiseUsd: round(appCapacityPerHour(step) * appHours),
    loadUsd: round(
      (generatorsPerHour(step) + loadExitPerHour(step) + usageCeilingPerHour(step)) * loadHours,
    ),
  };
}

/**
 * Every generator byte passes through the load network's one gateway: the
 * app's answers, which the egress ceiling bounds, and the generators' own
 * lines, which the logs ceiling bounds.
 */
function loadExitPerHour(step: Step) {
  const gbPerHour = step.load.egressGbPerHour + step.load.logsGbPerHour;
  return (
    PRICES.natGateway.perHour + PRICES.publicAddressPerHour + gbPerHour * PRICES.natGateway.perGb
  );
}

function appCapacityPerHour(step: Step) {
  const { api, worker, auth, mock, web } = step.services;
  const services = [api, worker, auth, mock, web];
  return (
    sum(services.map(fargatePerHour)) +
    databasePerHour(step) +
    PRICES.loadBalancer.perHour +
    (step.loadBalancer.reservedCapacityUnits ?? 0) * PRICES.loadBalancer.perLcuHour +
    INTERFACE_ENDPOINT_COUNT * AVAILABILITY_ZONES * PRICES.interfaceEndpointPerAzHour +
    PRICES.bastionPerHour
  );
}

function databasePerHour(step: Step) {
  const instance = PRICES.rdsInstancePerHour[step.database.instanceClass];
  if (instance === undefined) {
    throw new Error(`No price for ${step.database.instanceClass}; add it to config/prices.ts`);
  }
  const storage = (step.database.storageGiB * PRICES.rdsGp3PerGbMonth) / HOURS_PER_MONTH;
  return instance + storage;
}

/** Capacity units the load uses beyond those reserved, which the raise already pays for. */
function usageCeilingPerHour(step: Step) {
  const needed = Math.max(1, (step.load.users / CONNECTIONS_PER_LCU) * 1.5);
  const lcus = Math.max(0, needed - (step.loadBalancer.reservedCapacityUnits ?? 0));
  const cacheEcpuMillions = (step.cache.maxEcpuPerSecond * 3_600) / 1_000_000;
  return (
    lcus * PRICES.loadBalancer.perLcuHour +
    step.cache.maxStorageGb * PRICES.redisServerless.perGbHour +
    cacheEcpuMillions * PRICES.redisServerless.perMillionEcpu +
    step.load.egressGbPerHour * PRICES.egressPerGb +
    step.load.logsGbPerHour * PRICES.logsIngestPerGb
  );
}

/** The generators at Spot prices when the step runs them on Spot, On-Demand otherwise. */
function generatorsPerHour(step: Step) {
  const price = step.load.spot ? PRICES.fargateSpot : PRICES.fargate;
  return step.load.generators * fargatePerTaskHour(step.load.generator, price);
}

/** A service at the most tasks it can run, which for a scaling service is its ceiling. */
function fargatePerHour(service: ServiceConfig) {
  return maxTasksOf(service) * fargatePerTaskHour(service, PRICES.fargate);
}

function fargatePerTaskHour(
  size: Pick<ServiceConfig, 'cpu' | 'memoryMiB'>,
  price: { perVcpuHour: number; perGbHour: number },
) {
  return (size.cpu / 1024) * price.perVcpuHour + (size.memoryMiB / 1024) * price.perGbHour;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const round = (usd: number) => Math.ceil(usd * 100) / 100;

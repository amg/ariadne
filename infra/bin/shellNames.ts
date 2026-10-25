import { CLOUDFLARE_IPV4_RANGES } from '../config/cloudflareRanges.ts';
import {
  AUTH_CORE_IMAGE,
  AUTH_CORE_TAG,
  DAILY_WORST_CASE_LIMIT_USD,
  FARGATE_QUOTAS,
  HOSTNAME,
  IMAGES,
  LIFETIME_TAG,
  LOAD_KEY_HEADER,
  ORIGIN_TRUST_KEY,
  OUTPUTS,
  PARAMETERS,
  POPULATION,
  PROJECT,
  RAISE_TAGS,
  REGION,
  STACKS,
  ZONE,
} from '../config/names.ts';
import { STEP_NAMES, stepNamed } from '../config/steps.ts';

/**
 * Prints the shared names as shell assignments, so the operator scripts
 * read them from the same place as the CDK app:
 *   eval "$(tsx bin/shellNames.ts [step])"
 * With a step, its load settings are printed too.
 */
const names: Record<string, string | number> = {
  REGION,
  HOSTNAME_FQDN: HOSTNAME,
  ZONE_NAME: ZONE,
  PROJECT,
  CORE_STACK: STACKS.core,
  APP_STACK: STACKS.app,
  LOAD_STACK: STACKS.load,
  LIFETIME_TAG,
  STEP_TAG: RAISE_TAGS.step,
  IMAGE_TAG_TAG: RAISE_TAGS.imageTag,
  SEED_SNAPSHOT_TAG: RAISE_TAGS.seedSnapshot,
  CLOUDFLARE_RANGES: CLOUDFLARE_IPV4_RANGES.join(' '),
  IMAGES: IMAGES.join(' '),
  AUTH_CORE_IMAGE,
  AUTH_CORE_TAG,
  LOAD_KEY_HEADER,
  ORIGIN_TRUST_KEY,
  DAILY_WORST_CASE_LIMIT_USD,
  POPULATION_SIZE: POPULATION.size,
  PARAM_RUN_KEY: PARAMETERS.runKey,
  PARAM_ORIGIN_CERT: PARAMETERS.originCertificateArn,
  PARAM_LOAD_CLIENT_CERT: PARAMETERS.loadClientCertificate,
  PARAM_LOAD_CLIENT_KEY: PARAMETERS.loadClientKey,
  PARAM_LOAD_IMAGE_TAG: PARAMETERS.loadImageTag,
  QUOTA_FARGATE_ON_DEMAND: FARGATE_QUOTAS.onDemand,
  QUOTA_FARGATE_SPOT: FARGATE_QUOTAS.spot,
  STEP_NAMES: STEP_NAMES.join(' '),
};
for (const [key, value] of Object.entries(OUTPUTS)) {
  names[`OUT_${toShellCase(key)}`] = value;
}

const stepName = process.argv[2];
if (stepName !== undefined) {
  const step = stepNamed(stepName);
  names.STEP_DB_SOURCE = step.database.source;
  names.STEP_GENERATORS = step.load.generators;
  names.STEP_USERS = step.load.users;
  names.STEP_API_COUNT = step.services.api.count;
  names.STEP_API_CPU = step.services.api.cpu;
  names.STEP_API_MEM = step.services.api.memoryMiB;
  names.STEP_WORKER_COUNT = step.services.worker.count;
  names.STEP_WORKER_CPU = step.services.worker.cpu;
  names.STEP_WORKER_MEM = step.services.worker.memoryMiB;
  names.STEP_AUTH_COUNT = step.services.auth.count;
  names.STEP_AUTH_CPU = step.services.auth.cpu;
  names.STEP_AUTH_MEM = step.services.auth.memoryMiB;
  names.STEP_MOCK_COUNT = step.services.mock.count;
  names.STEP_MOCK_CPU = step.services.mock.cpu;
  names.STEP_MOCK_MEM = step.services.mock.memoryMiB;
  names.STEP_WEB_COUNT = step.services.web.count;
  names.STEP_WEB_CPU = step.services.web.cpu;
  names.STEP_WEB_MEM = step.services.web.memoryMiB;
  names.STEP_DB_CLASS = step.database.instanceClass;
  names.STEP_LB_RESERVED_UNITS = step.loadBalancer.reservedCapacityUnits ?? 0;
}

for (const [key, value] of Object.entries(names)) {
  console.log(`${key}=${shellQuote(String(value))}`);
}

function toShellCase(camel: string) {
  return camel.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

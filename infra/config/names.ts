/**
 * Every name aws-prod shares between the CDK app, the Terraform roots and
 * the operator scripts. The scripts read these through `bin/shellNames.ts`,
 * so a name changes in one place only.
 *
 * The three operator values live in the repository-root `.env`, which never
 * enters git (see the infra README for the template). Everything else here
 * derives from them, so this repository names no one's domain or account.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoEnvFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(repoEnvFile)) process.loadEnvFile(repoEnvFile);

function operatorValue(name: string, example: string) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set; add ${name}=${example} to the repository-root .env`);
  }
  return value;
}

/** The public hostname, proxied by Cloudflare. */
export const HOSTNAME = operatorValue('AWS_PROD_HOSTNAME', 'aws-prod.example.com');

/** The Cloudflare zone the hostname lives in. */
export const ZONE = operatorValue('AWS_PROD_ZONE', 'example.com');
if (!HOSTNAME.endsWith(`.${ZONE}`)) {
  throw new Error(`AWS_PROD_HOSTNAME must be inside AWS_PROD_ZONE (end with ".${ZONE}")`);
}

/**
 * The project id: lower-case letters, digits and hyphens. It prefixes every
 * stack, tag key, bucket, repository and parameter an operator raises, so
 * what one operator stands up is labelled theirs.
 */
export const PROJECT = operatorValue('AWS_PROD_PROJECT', 'aws-prod');
if (!/^[a-z][a-z0-9-]{0,39}$/.test(PROJECT)) {
  throw new Error(
    'AWS_PROD_PROJECT must be 1-40 of lower-case letters, digits and hyphens, starting with a letter',
  );
}

export const REGION = 'ap-southeast-2';

/** Two zones: the fewest the load balancer, RDS and ElastiCache accept. */
export const AVAILABILITY_ZONES = ['ap-southeast-2a', 'ap-southeast-2b'];

const pascal = PROJECT.split('-')
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join('');

export const STACKS = {
  core: `${pascal}Core`,
  app: `${pascal}App`,
  load: `${pascal}Load`,
} as const;

/** The three lifetimes a resource can belong to; every resource is tagged with one. */
export type Lifetime = 'core' | 'app' | 'load';
export const LIFETIME_TAG = `${PROJECT}:lifetime`;

/** Stack tags recording what a raise runs, read back by the load and status commands. */
export const RAISE_TAGS = {
  step: `${PROJECT}:step`,
  imageTag: `${PROJECT}:image-tag`,
  seedSnapshot: `${PROJECT}:seed-snapshot`,
} as const;
export const PROJECT_TAG = `${PROJECT}:project`;

/** How long a raise may live before the safety net deletes it. */
export const SAFETY_NET = {
  appMinutes: 180,
  loadMinutes: 100,
} as const;

/** A raise is refused once the day's recorded worst cases would pass this. */
export const DAILY_WORST_CASE_LIMIT_USD = 100;

export const PORTS = {
  api: 3001,
  auth: 3567,
  mock: 4141,
  web: 8080,
  postgres: 5432,
} as const;

/** Private DNS names the services find each other by, inside the app network. */
export const INTERNAL_DOMAIN = `${PROJECT}.internal`;
export const INTERNAL_NAMES = {
  auth: 'auth',
  mock: 'mock',
} as const;

export const DATABASE = {
  name: 'chatbot',
  /** Postgres identifiers take no hyphens. */
  masterUser: PROJECT.replaceAll('-', '_'),
};

/** Image repositories in core; each raise pushes one immutable tag to each. */
export const IMAGES = ['backend', 'web', 'auth', 'tools', 'load'] as const;
export type ImageName = (typeof IMAGES)[number];
export const repositoryName = (image: ImageName) => `${PROJECT}/${image}`;

/** The auth core release mirrored into the `auth` repository; kept in step with compose. */
export const AUTH_CORE_TAG = '12.2';
export const AUTH_CORE_IMAGE = `supertokens/supertokens-postgresql:${AUTH_CORE_TAG}`;

/** Load generators prove they are ours with this header and the per-run key. */
export const LOAD_KEY_HEADER = `x-${PROJECT}-load-key`;

/** Synthetic accounts: `user-000042@<domain>`, all sharing the population password. */
export const POPULATION = {
  size: 100_000,
  emailDomain: `load.${PROJECT}.invalid`,
} as const;

/** Parameters the scripts write and the stacks read at deploy time. */
export const PARAMETERS = {
  runKey: `/${PROJECT}/run-key`,
  originCertificateArn: `/${PROJECT}/origin-certificate-arn`,
  /** The client certificate and key load generators present on the direct path. */
  loadClientCertificate: `/${PROJECT}/load-client-certificate`,
  loadClientKey: `/${PROJECT}/load-client-key`,
  /** The image tag the load generators run, which a raise starts as its own and `load-image` replaces. */
  loadImageTag: `/${PROJECT}/load-image-tag`,
} as const;

/** The Service Quotas codes of the Fargate vCPU quotas that bound a raise. */
export const FARGATE_QUOTAS = {
  onDemand: 'L-3032A538',
  spot: 'L-36FBB829',
} as const;

/** Where the origin's client-certificate authority sits in the vault bucket. */
export const ORIGIN_TRUST_KEY = 'origin-trust/ca.pem';

export const vaultBucketName = (account: string) => `${PROJECT}-vault-${account}`;

/** CloudFormation output keys the scripts read back after a deploy. */
export const OUTPUTS = {
  vaultBucket: 'VaultBucket',
  originDnsName: 'OriginDnsName',
  clusterName: 'ClusterName',
  databaseId: 'DatabaseId',
  databaseEndpoint: 'DatabaseEndpoint',
  databaseSecret: 'DatabaseSecret',
  bastionId: 'BastionId',
  warmTaskDefinition: 'WarmTaskDefinition',
  warmSecurityGroup: 'WarmSecurityGroup',
  appSubnets: 'AppSubnets',
  loadCluster: 'LoadCluster',
  loadTaskDefinition: 'LoadTaskDefinition',
  loadSecurityGroup: 'LoadSecurityGroup',
  loadSubnets: 'LoadSubnets',
  loadLogGroup: 'LoadLogGroup',
} as const;

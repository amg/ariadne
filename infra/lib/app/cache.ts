import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import { Construct } from 'constructs';
import { PROJECT } from '../../config/names.ts';
import type { Step } from '../../config/steps.ts';
import { type Network, SUBNETS } from './network.ts';

const REDIS_PORTS = ec2.Port.tcpRange(6379, 6380);

/**
 * Valkey, serverless, with hard limits on storage and request rate. It
 * carries what every backend copy must share: the event bus and a user's
 * stop. Rate-limit counters are in-memory (home) or at the Cloudflare edge
 * (prod).
 */
export class Cache extends Construct {
  /** `rediss://` because the serverless cache only speaks TLS. */
  readonly url: string;
  readonly connections: ec2.Connections;

  constructor(scope: Construct, id: string, props: { network: Network; step: Step }) {
    super(scope, id);
    const { network, step } = props;

    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: network.vpc,
      description: 'Redis (Valkey engine): reachable only from what is allowed in',
      allowAllOutbound: false,
    });
    this.connections = new ec2.Connections({
      securityGroups: [securityGroup],
      defaultPort: REDIS_PORTS,
    });

    const cache = new elasticache.CfnServerlessCache(this, 'Valkey', {
      serverlessCacheName: PROJECT,
      engine: 'valkey',
      majorEngineVersion: '8',
      subnetIds: network.vpc.selectSubnets(SUBNETS.data).subnetIds,
      securityGroupIds: [securityGroup.securityGroupId],
      cacheUsageLimits: {
        dataStorage: { maximum: step.cache.maxStorageGb, unit: 'GB' },
        ecpuPerSecond: { maximum: step.cache.maxEcpuPerSecond },
      },
    });

    this.url = `rediss://${cache.attrEndpointAddress}:${cache.attrEndpointPort}`;
  }
}

import { CfnOutput, Stack, type StackProps, Tags } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type { Construct } from 'constructs';
import { AVAILABILITY_ZONES, INTERNAL_DOMAIN, OUTPUTS, RAISE_TAGS } from '../../config/names.ts';
import type { Step } from '../../config/steps.ts';
import { markLifetime } from '../lifetime.ts';
import type { CoreResources } from '../types/core.ts';
import { Cache } from './cache.ts';
import { Database } from './database.ts';
import { Network, SUBNETS } from './network.ts';
import { OperatorAccess } from './operatorAccess.ts';
import { Origin } from './origin.ts';
import { Services } from './services.ts';

type AppStackProps = StackProps & {
  step: Step;
  imageTag: string;
  /** The snapshot the database is restored from; null for a step that starts empty. */
  seedSnapshot: string | null;
  core: CoreResources;
};

/** Everything that exists while aws-prod is up. Deleting this stack deletes all of it. */
export class AppStack extends Stack {
  /** Pinned rather than looked up, so synthesis needs no AWS call. */
  override get availabilityZones(): string[] {
    return AVAILABILITY_ZONES;
  }

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    markLifetime(this, 'app');
    const { step, imageTag, seedSnapshot, core } = props;
    Tags.of(this).add(RAISE_TAGS.step, step.name);
    Tags.of(this).add(RAISE_TAGS.imageTag, imageTag);
    if (seedSnapshot !== null) Tags.of(this).add(RAISE_TAGS.seedSnapshot, seedSnapshot);

    const network = new Network(this, 'Network');
    const database = new Database(this, 'Database', { network, step, seedSnapshot });
    const cache = new Cache(this, 'Cache', { network, step });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: network.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      defaultCloudMapNamespace: { name: INTERNAL_DOMAIN, useForServiceConnect: false },
    });

    const services = new Services(this, 'Services', {
      cluster,
      step,
      imageTag,
      core,
      database,
      cache,
    });
    const origin = new Origin(this, 'Origin', {
      network,
      vault: core.vault,
      api: services.api,
      web: services.web,
      reservedCapacityUnits: step.loadBalancer.reservedCapacityUnits,
    });
    const access = new OperatorAccess(this, 'OperatorAccess', {
      network,
      database,
      cache,
      toolsRepository: core.repositories.tools,
      imageTag,
    });

    const outputs: Record<string, string> = {
      [OUTPUTS.originDnsName]: origin.loadBalancer.loadBalancerDnsName,
      [OUTPUTS.clusterName]: cluster.clusterName,
      [OUTPUTS.databaseId]: database.instance.instanceIdentifier,
      [OUTPUTS.databaseEndpoint]: database.instance.dbInstanceEndpointAddress,
      [OUTPUTS.databaseSecret]: database.secret.secretArn,
      [OUTPUTS.bastionId]: access.bastion.instanceId,
      [OUTPUTS.warmTaskDefinition]: access.warmTask.taskDefinitionArn,
      [OUTPUTS.warmSecurityGroup]: access.warmSecurityGroup.securityGroupId,
      [OUTPUTS.appSubnets]: network.vpc.selectSubnets(SUBNETS.app).subnetIds.join(','),
    };
    for (const [key, value] of Object.entries(outputs)) new CfnOutput(this, key, { value });
  }
}

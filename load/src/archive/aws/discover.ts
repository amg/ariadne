import {
  CloudFormationClient,
  DescribeStacksCommand,
  paginateListStackResources,
} from '@aws-sdk/client-cloudformation';
import { DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds';
import { GENERATOR_LABEL } from './raise.ts';

/** One resource of a stack, as CloudFormation lists it. */
type StackResource = { logicalId: string; type: string; physicalId: string };

type StackFacts = { name: string; id: string; createdAt: Date; resources: StackResource[] };

const SERVICE_NAME = /Services(Api|Worker|Auth|Mock|Web)/;
const HASH = /[0-9A-F]{8}$/;

/** The service a resource belongs to, named by the construct that made it: `ServicesApiLogs…` is the API's. */
function serviceLabelOrNull(logicalId: string) {
  const found = SERVICE_NAME.exec(logicalId);
  return found?.[1]?.toLowerCase() ?? null;
}

/** A label for a log group, from the name CloudFormation gave the construct that made it. */
export function logGroupLabelOf(logicalId: string, stack: 'app' | 'load') {
  if (stack === 'load') return GENERATOR_LABEL;
  const service = serviceLabelOrNull(logicalId);
  if (service !== null) return service;
  return logicalId
    .replace(HASH, '')
    .replace(/Logs$/, '')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

function ofType(resources: readonly StackResource[], type: string) {
  return resources.filter((resource) => resource.type === type);
}

function onlyOne(resources: readonly StackResource[], type: string, stack: string) {
  const [first, ...more] = ofType(resources, type);
  if (first === undefined || more.length > 0) {
    throw new Error(
      `${stack} should hold exactly one ${type}, and holds ${more.length + (first ? 1 : 0)}`,
    );
  }
  return first;
}

/** The part of an ARN after its resource type, such as `app/name/id` of a load balancer's. */
function afterResourceType(arn: string, type: string) {
  const [, rest] = arn.split(`:${type}/`);
  if (rest === undefined) throw new Error(`${arn} is not the ARN of a ${type}`);
  return rest;
}

/** The raise as its two stacks describe it. */
export function raiseOf(input: {
  app: StackFacts;
  load: StackFacts;
  databaseResourceId: string | null;
}) {
  const { app, load } = input;
  const [, , , region = '', account = ''] = app.id.split(':');
  const cluster = (stack: StackFacts): string =>
    onlyOne(stack.resources, 'AWS::ECS::Cluster', stack.name).physicalId;
  const loadBalancer = afterResourceType(
    onlyOne(app.resources, 'AWS::ElasticLoadBalancingV2::LoadBalancer', app.name).physicalId,
    'loadbalancer',
  );
  return {
    account,
    region,
    startedAt: app.createdAt.toISOString(),
    stacks: { app: { name: app.name, id: app.id }, load: { name: load.name, id: load.id } },
    clusters: { app: cluster(app), load: cluster(load) },
    services: ofType(app.resources, 'AWS::ECS::Service').map((service) => ({
      label: serviceLabelOrNull(service.logicalId) ?? service.logicalId,
      cluster: cluster(app),
      name: service.physicalId.split('/').pop() ?? service.physicalId,
    })),
    logGroups: [
      ...ofType(app.resources, 'AWS::Logs::LogGroup').map((group) => ({
        label: logGroupLabelOf(group.logicalId, 'app'),
        name: group.physicalId,
        stack: 'app' as const,
      })),
      ...ofType(load.resources, 'AWS::Logs::LogGroup').map((group) => ({
        label: logGroupLabelOf(group.logicalId, 'load'),
        name: group.physicalId,
        stack: 'load' as const,
      })),
    ],
    loadBalancer: { dimension: loadBalancer },
    targetGroups: ofType(app.resources, 'AWS::ElasticLoadBalancingV2::TargetGroup').map(
      (group) => `targetgroup/${afterResourceType(group.physicalId, 'targetgroup')}`,
    ),
    database: {
      identifier: onlyOne(app.resources, 'AWS::RDS::DBInstance', app.name).physicalId,
      resourceId: input.databaseResourceId,
    },
    cache: {
      name: onlyOne(app.resources, 'AWS::ElastiCache::ServerlessCache', app.name).physicalId,
    },
  };
}

async function stackFacts(client: CloudFormationClient, name: string) {
  const { Stacks } = await client.send(new DescribeStacksCommand({ StackName: name }));
  const stack = Stacks?.[0];
  if (stack?.StackId === undefined || stack.CreationTime === undefined) {
    throw new Error(`${name} is not a stack that is up`);
  }
  const resources: StackResource[] = [];
  for await (const page of paginateListStackResources({ client }, { StackName: name })) {
    for (const summary of page.StackResourceSummaries ?? []) {
      if (summary.PhysicalResourceId !== undefined && summary.ResourceType !== undefined) {
        resources.push({
          logicalId: summary.LogicalResourceId ?? '',
          type: summary.ResourceType,
          physicalId: summary.PhysicalResourceId,
        });
      }
    }
  }
  return { name, id: stack.StackId, createdAt: stack.CreationTime, resources };
}

/** Describes the raise that stands now, from its two stacks. Both must be up. */
export async function discoverRaise(input: { appStack: string; loadStack: string }) {
  const formation = new CloudFormationClient({});
  const [app, load] = await Promise.all([
    stackFacts(formation, input.appStack),
    stackFacts(formation, input.loadStack),
  ]);
  const identifier = onlyOne(app.resources, 'AWS::RDS::DBInstance', app.name).physicalId;
  const { DBInstances } = await new RDSClient({}).send(
    new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }),
  );
  return raiseOf({
    app,
    load,
    databaseResourceId: DBInstances?.[0]?.DbiResourceId ?? null,
  });
}

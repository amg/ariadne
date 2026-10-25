import { describe, expect, it } from 'vitest';
import { logGroupLabelOf, raiseOf } from './discover.ts';

const resource = (logicalId: string, type: string, physicalId: string) => ({
  logicalId,
  type,
  physicalId,
});

const app = {
  name: 'AwsProdApp',
  id: 'arn:aws:cloudformation:ap-southeast-2:123456789012:stack/AwsProdApp/uuid-a',
  createdAt: new Date('2026-10-15T00:00:00.000Z'),
  resources: [
    resource('ClusterEB0386A7', 'AWS::ECS::Cluster', 'AwsProdApp-ClusterEB0386A7-x'),
    resource(
      'ServicesApiServiceDC3C1592',
      'AWS::ECS::Service',
      'arn:aws:ecs:ap-southeast-2:123456789012:service/AwsProdApp-Cluster/AwsProdApp-ApiService-q',
    ),
    resource(
      'ServicesWorkerServiceEA52D4DF',
      'AWS::ECS::Service',
      'arn:aws:ecs:ap-southeast-2:123456789012:service/AwsProdApp-Cluster/AwsProdApp-WorkerService-r',
    ),
    resource('ServicesApiLogs98F5DD50', 'AWS::Logs::LogGroup', 'AwsProdApp-ServicesApiLogs-abc'),
    resource(
      'ServicesWorkerLogs056F8782',
      'AWS::Logs::LogGroup',
      'AwsProdApp-ServicesWorkerLogs-def',
    ),
    resource('NetworkFlowLogs2BEC3212', 'AWS::Logs::LogGroup', 'AwsProdApp-NetworkFlowLogs-ghi'),
    resource(
      'OriginLoadBalancer839D1DDC',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'arn:aws:elasticloadbalancing:ap-southeast-2:123456789012:loadbalancer/app/AwsPr-Origi-ABC/50dc6c495c0c9188',
    ),
    resource(
      'OriginLoadBalancerHttpsApiGroup762602BA',
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      'arn:aws:elasticloadbalancing:ap-southeast-2:123456789012:targetgroup/AwsPr-Api/73e2d6bc24d8a067',
    ),
    resource('DatabaseInstanceAA8A5FDE', 'AWS::RDS::DBInstance', 'awsprodapp-database'),
    resource('CacheValkey8BCB8589', 'AWS::ElastiCache::ServerlessCache', 'aws-prod'),
  ],
};

const load = {
  name: 'AwsProdLoad',
  id: 'arn:aws:cloudformation:ap-southeast-2:123456789012:stack/AwsProdLoad/uuid-b',
  createdAt: new Date('2026-10-15T00:05:00.000Z'),
  resources: [
    resource('ClusterEB0386A7', 'AWS::ECS::Cluster', 'AwsProdLoad-Cluster-y'),
    resource('Logs6819BB44', 'AWS::Logs::LogGroup', 'AwsProdLoad-Logs-z'),
  ],
};

const raised = () => raiseOf({ app, load, databaseResourceId: 'db-ABC' });

describe('raiseOf', () => {
  it('names the account, the region and when the raise began from the app stack', () => {
    expect(raised()).toMatchObject({
      account: '123456789012',
      region: 'ap-southeast-2',
      startedAt: '2026-10-15T00:00:00.000Z',
    });
  });

  it('names each service by what it is, with its cluster and its own name', () => {
    expect(raised().services).toEqual([
      { label: 'api', cluster: 'AwsProdApp-ClusterEB0386A7-x', name: 'AwsProdApp-ApiService-q' },
      {
        label: 'worker',
        cluster: 'AwsProdApp-ClusterEB0386A7-x',
        name: 'AwsProdApp-WorkerService-r',
      },
    ]);
    expect(raised().clusters).toEqual({
      app: 'AwsProdApp-ClusterEB0386A7-x',
      load: 'AwsProdLoad-Cluster-y',
    });
  });

  it('finds every log group of both stacks, the generators’ among them', () => {
    expect(raised().logGroups).toEqual([
      { label: 'api', name: 'AwsProdApp-ServicesApiLogs-abc', stack: 'app' },
      { label: 'worker', name: 'AwsProdApp-ServicesWorkerLogs-def', stack: 'app' },
      { label: 'network-flow', name: 'AwsProdApp-NetworkFlowLogs-ghi', stack: 'app' },
      { label: 'generator', name: 'AwsProdLoad-Logs-z', stack: 'load' },
    ]);
  });

  it('names the load balancer as CloudWatch does, and its target groups', () => {
    expect(raised().loadBalancer).toEqual({
      dimension: 'app/AwsPr-Origi-ABC/50dc6c495c0c9188',
    });
    expect(raised().targetGroups).toEqual(['targetgroup/AwsPr-Api/73e2d6bc24d8a067']);
  });

  it('keeps the database and the cache', () => {
    expect(raised()).toMatchObject({
      database: { identifier: 'awsprodapp-database', resourceId: 'db-ABC' },
      cache: { name: 'aws-prod' },
    });
  });

  it('refuses a stack that holds two clusters, rather than choosing one', () => {
    const twice = {
      ...app,
      resources: [...app.resources, resource('Other', 'AWS::ECS::Cluster', 'another')],
    };

    expect(() => raiseOf({ app: twice, load, databaseResourceId: null })).toThrowError(
      'exactly one AWS::ECS::Cluster',
    );
  });
});

describe('logGroupLabelOf', () => {
  it.each([
    ['ServicesAuthLogsB2756258', 'app', 'auth'],
    ['ServicesMockLogs249E27CD', 'app', 'mock'],
    ['OperatorAccessWarmLogs7EBC1879', 'app', 'operator-access-warm'],
    ['NetworkFlowLogs2BEC3212', 'app', 'network-flow'],
    ['Logs6819BB44', 'load', 'generator'],
  ] as const)('labels %s in the %s stack %s', (logicalId, stack, label) => {
    expect(logGroupLabelOf(logicalId, stack)).toBe(label);
  });
});

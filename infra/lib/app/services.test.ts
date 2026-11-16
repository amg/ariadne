import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { REGION } from '../../config/names.ts';
import { stepNamed } from '../../config/steps.ts';
import { CoreStack } from '../core/coreStack.ts';
import { AppStack } from './appStack.ts';

/** The template of a step's raise. */
function appTemplateOf(stepName: string) {
  const app = new App();
  const env = { account: '123456789012', region: REGION };
  const core = new CoreStack(app, 'Core', { env });
  const step = stepNamed(stepName);
  const stack = new AppStack(app, 'App', {
    env,
    step,
    imageTag: 'test',
    seedSnapshot: step.database.source === 'seedSnapshot' ? 'seed-test' : null,
    core: core.resources,
  });
  return Template.fromStack(stack);
}

/** The environment of the worker's container in the raise of a step. */
function workerEnvironmentOf(stepName: string) {
  const definitions = Object.values(
    appTemplateOf(stepName).findResources('AWS::ECS::TaskDefinition'),
  );
  const worker = definitions.find(
    (definition) =>
      JSON.stringify(definition.Properties.ContainerDefinitions[0].Command) ===
      '["node","dist/worker.js"]',
  );
  assert.ok(worker !== undefined, 'the raise has a worker task definition');
  const variables: { Name: string; Value: string }[] =
    worker.Properties.ContainerDefinitions[0].Environment;
  return Object.fromEntries(variables.map(({ Name, Value }) => [Name, Value]));
}

describe('the worker of a raised step', () => {
  for (const name of ['step10', 'step50']) {
    it(`runs six jobs at once on ${name}`, () => {
      assert.equal(stepNamed(name).services.worker.jobConcurrency, 6);
      assert.equal(workerEnvironmentOf(name).WORKER_JOB_CONCURRENCY, '6');
    });
  }

  it('leaves the backend’s own number alone on a step that sets none', () => {
    assert.equal(stepNamed('smoke').services.worker.jobConcurrency, undefined);
    assert.equal(workerEnvironmentOf('smoke').WORKER_JOB_CONCURRENCY, undefined);
  });
});

describe('how a raised step deploys its services', () => {
  const deploymentOf = (stepName: string) =>
    Object.values(appTemplateOf(stepName).findResources('AWS::ECS::Service')).map(
      (service) => service.Properties.DeploymentConfiguration,
    );

  it('replaces the tasks of a load step, so a deploy needs no extra vCPU', () => {
    for (const configuration of deploymentOf('step50')) {
      assert.equal(configuration.MaximumPercent, 100);
      assert.equal(configuration.MinimumHealthyPercent, 0);
    }
  });

  it('keeps the capacity of production while it deploys', () => {
    for (const configuration of deploymentOf('step-prod')) {
      assert.equal(configuration.MaximumPercent, 200);
      assert.equal(configuration.MinimumHealthyPercent, 100);
    }
  });
});

describe('how the API lets go of a dead connection', () => {
  const containersOf = (stepName: string) =>
    Object.values(appTemplateOf(stepName).findResources('AWS::ECS::TaskDefinition')).map(
      (definition) => definition.Properties.ContainerDefinitions[0],
    );
  const isApi = (container: { Command?: string[] }): boolean =>
    (container.Command ?? []).join(' ').includes('dist/server.aws.js');
  const apiOf = (stepName: string) => containersOf(stepName).find(isApi);

  it('gives up on a write the far end never acknowledges within about 100 seconds', () => {
    for (const name of ['step10', 'step50', 'step-prod']) {
      assert.deepEqual(apiOf(name)?.SystemControls, [
        { Namespace: 'net.ipv4.tcp_retries2', Value: '8' },
      ]);
    }
  });

  it('leaves every other service with the platform’s own settings', () => {
    const others = containersOf('step10').filter((container) => !isApi(container));
    assert.ok(others.length > 0);
    for (const container of others) assert.equal(container.SystemControls, undefined);
  });
});

describe('the role each backend service runs as', () => {
  const roleOf = (stepName: string, command: string) => {
    const definitions = Object.values(
      appTemplateOf(stepName).findResources('AWS::ECS::TaskDefinition'),
    );
    const container = definitions
      .map((definition) => definition.Properties.ContainerDefinitions[0])
      .find((candidate) => (candidate.Command ?? []).join(' ').includes(command));
    const variables: { Name: string; Value: string }[] = container?.Environment ?? [];
    return variables.find(({ Name }) => Name === 'PROCESS_ROLE')?.Value;
  };

  it('runs the API as the API alone, so its pool is sized for requests', () => {
    for (const name of ['step10', 'step50', 'step-prod']) {
      assert.equal(roleOf(name, 'dist/server.aws.js'), 'api');
    }
  });

  it('runs the worker as the worker alone', () => {
    assert.equal(roleOf('step10', 'dist/worker.js'), 'worker');
  });
});

describe('how the API reaches auth', () => {
  /** Each service of a step's raise, by the command its container runs, or by its port when it runs the image's own. */
  function servicesOf(stepName: string) {
    const template = appTemplateOf(stepName);
    const definitions = template.findResources('AWS::ECS::TaskDefinition');
    return Object.entries(template.findResources('AWS::ECS::Service')).map(([id, service]) => {
      const container =
        definitions[service.Properties.TaskDefinition.Ref]?.Properties.ContainerDefinitions[0];
      return {
        id,
        command: (container?.Command ?? []).join(' '),
        ports: container?.PortMappings ?? [],
        connect: service.Properties.ServiceConnectConfiguration,
        registries: service.Properties.ServiceRegistries,
        dependsOn: service.DependsOn ?? [],
      };
    });
  }
  const authOf = (services: ReturnType<typeof servicesOf>) =>
    services.find((service) =>
      service.ports.some((port: { ContainerPort: number }) => port.ContainerPort === 3567),
    );
  const apiOf = (services: ReturnType<typeof servicesOf>) =>
    services.find((service) => service.command.includes('dist/server.aws.js'));

  it('offers auth through Service Connect at the name the backend already calls, and not by DNS', () => {
    const auth = authOf(servicesOf('step10'));

    assert.deepEqual(auth?.connect?.Services, [
      {
        PortName: 'main',
        DiscoveryName: 'auth',
        ClientAliases: [{ DnsName: 'auth.aws-prod.internal', Port: 3567 }],
      },
    ]);
    assert.equal(auth?.registries, undefined);
    assert.deepEqual(auth?.ports, [
      { ContainerPort: 3567, Name: 'main', AppProtocol: 'http', Protocol: 'tcp' },
    ]);
  });

  it('makes the API a client of Service Connect, raised once auth is offered there', () => {
    const services = servicesOf('step10');
    const api = apiOf(services);

    assert.equal(api?.connect?.Enabled, true);
    assert.equal(api?.connect?.Services, undefined);
    assert.ok(api?.dependsOn.includes(authOf(services)?.id));
  });

  it('leaves the worker, which never calls auth, and mock, found by DNS, out of it', () => {
    const others = servicesOf('step10').filter(
      (service) =>
        service.command.includes('dist/worker.js') || service.command.includes('mock/server.ts'),
    );

    assert.equal(others.length, 2);
    for (const service of others) assert.equal(service.connect, undefined);
  });
});

describe('the scaling rehearsal’s raise', () => {
  it('starts each service that scales at its floor, free to grow to its ceiling on its CPU', () => {
    const template = appTemplateOf('scale10');
    const targets = Object.values(
      template.findResources('AWS::ApplicationAutoScaling::ScalableTarget'),
    ).map((target) => [target.Properties.MinCapacity, target.Properties.MaxCapacity]);
    const cpuTargets = Object.values(
      template.findResources('AWS::ApplicationAutoScaling::ScalingPolicy', {
        Properties: { PolicyType: 'TargetTrackingScaling' },
      }),
    ).map(
      (policy) => policy.Properties.TargetTrackingScalingPolicyConfiguration.TargetValue as number,
    );

    assert.deepEqual(
      targets.sort((a, b) => a[1] - b[1]),
      [
        [2, 6],
        [2, 8],
        [2, 12],
      ],
    );
    assert.deepEqual(
      cpuTargets.sort((a, b) => a - b),
      [60, 65, 70],
    );
  });

  it('leaves the count of a service that scales to the autoscaler, and fixes the rest', () => {
    const counts = Object.values(appTemplateOf('scale10').findResources('AWS::ECS::Service')).map(
      (service) => service.Properties.DesiredCount,
    );

    assert.deepEqual(counts.filter((count) => count !== undefined).sort(), [1, 2]);
  });
});

/**
 * Each scaling service in the raise of a step: its floor and ceiling, its
 * target tracking policies, and its step scaling policies with the alarms
 * that set them off.
 */
function scalingOf(stepName: string) {
  const template = appTemplateOf(stepName);
  const policies = Object.entries(
    template.findResources('AWS::ApplicationAutoScaling::ScalingPolicy'),
  );
  const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
  const targets = template.findResources('AWS::ApplicationAutoScaling::ScalableTarget');
  return Object.entries(targets).map(([targetId, target]) => {
    const own = policies.filter(([, policy]) => policy.Properties.ScalingTargetId.Ref === targetId);
    return {
      floor: target.Properties.MinCapacity as number,
      ceiling: target.Properties.MaxCapacity as number,
      tracking: own
        .filter(([, policy]) => policy.Properties.PolicyType === 'TargetTrackingScaling')
        .map(([, policy]) => policy.Properties.TargetTrackingScalingPolicyConfiguration),
      steps: own
        .filter(([, policy]) => policy.Properties.PolicyType === 'StepScaling')
        .map(([policyId, policy]) => ({
          configuration: policy.Properties.StepScalingPolicyConfiguration,
          alarms: alarms
            .filter((alarm) =>
              (alarm.Properties.AlarmActions ?? []).some(
                (action: { Ref?: string }) => action.Ref === policyId,
              ),
            )
            .map((alarm) => alarm.Properties),
        })),
    };
  });
}

describe('the scaling rehearsal at step50’s load', () => {
  it('starts the API and worker at 2 and auth at 4, free to grow to step50’s counts on their CPU', () => {
    const services = scalingOf('scale50');

    assert.deepEqual(
      [...services]
        .sort((a, b) => a.ceiling - b.ceiling)
        .map(({ floor, ceiling }) => [floor, ceiling]),
      [
        [4, 16],
        [2, 20],
        [2, 40],
      ],
    );
    assert.deepEqual(
      services
        .flatMap(({ tracking }) => tracking.map(({ TargetValue }) => TargetValue))
        .sort((a, b) => a - b),
      [60, 65, 70],
    );
  });
});

describe('the quick scale-out', () => {
  for (const name of ['scale10', 'scale50', 'step-prod']) {
    it(`sits beside the CPU target of every service that scales on ${name}, firing after one minute at it`, () => {
      const services = scalingOf(name);

      assert.equal(services.length, 3);
      for (const { tracking, steps } of services) {
        assert.equal(tracking.length, 1);
        assert.equal(steps.length, 1);
        const alarms = steps[0]?.alarms ?? [];
        assert.equal(alarms.length, 1);
        const {
          Namespace,
          MetricName,
          Statistic,
          Period,
          EvaluationPeriods,
          ComparisonOperator,
          Threshold,
        } = alarms[0];
        assert.deepEqual(
          {
            Namespace,
            MetricName,
            Statistic,
            Period,
            EvaluationPeriods,
            ComparisonOperator,
            Threshold,
          },
          {
            Namespace: 'AWS/ECS',
            MetricName: 'CPUUtilization',
            Statistic: 'Average',
            Period: 60,
            EvaluationPeriods: 1,
            ComparisonOperator: 'GreaterThanOrEqualToThreshold',
            Threshold: tracking[0].TargetValue,
          },
        );
      }
    });
  }

  it('adds half the tasks, at least two, or doubles them 20 points past the target, a minute apart', () => {
    const services = scalingOf('scale50');

    assert.equal(services.length, 3);
    for (const { steps } of services) {
      assert.equal(steps.length, 1);
      assert.deepEqual(steps[0]?.configuration, {
        AdjustmentType: 'PercentChangeInCapacity',
        Cooldown: 60,
        MetricAggregationType: 'Average',
        MinAdjustmentMagnitude: 2,
        StepAdjustments: [
          { MetricIntervalLowerBound: 0, MetricIntervalUpperBound: 20, ScalingAdjustment: 50 },
          { MetricIntervalLowerBound: 20, ScalingAdjustment: 100 },
        ],
      });
    }
  });

  it('only adds tasks, leaving their removal to the CPU target', () => {
    const services = scalingOf('scale50');

    assert.equal(services.length, 3);
    for (const { tracking, steps } of services) {
      const adjustments = steps.flatMap(({ configuration }) => configuration.StepAdjustments);

      assert.equal(adjustments.length, 2);
      assert.ok(adjustments.every(({ ScalingAdjustment }) => ScalingAdjustment > 0));
      assert.ok(adjustments.every(({ MetricIntervalLowerBound }) => MetricIntervalLowerBound >= 0));
      assert.notEqual(tracking[0].DisableScaleIn, true);
    }
  });
});

describe('the API’s health check', () => {
  it('removes an API task only after five missed checks of ten seconds each, thirty seconds apart', () => {
    const groups = Object.values(
      appTemplateOf('scale50').findResources('AWS::ElasticLoadBalancingV2::TargetGroup', {
        Properties: { HealthCheckPath: '/api/health' },
      }),
    );

    assert.equal(groups.length, 1);
    const { HealthCheckIntervalSeconds, HealthCheckTimeoutSeconds, UnhealthyThresholdCount } =
      groups[0]?.Properties ?? {};
    assert.deepEqual(
      { HealthCheckIntervalSeconds, HealthCheckTimeoutSeconds, UnhealthyThresholdCount },
      { HealthCheckIntervalSeconds: 30, HealthCheckTimeoutSeconds: 10, UnhealthyThresholdCount: 5 },
    );
  });
});

describe('the database’s checkpoints', () => {
  for (const name of ['smoke', 'scale50', 'step-prod']) {
    it(`keep 8 GB of compressed log and at most 15 minutes between them on ${name}`, () => {
      const groups = Object.values(appTemplateOf(name).findResources('AWS::RDS::DBParameterGroup'));

      assert.equal(groups.length, 1);
      const { max_wal_size, checkpoint_timeout, wal_compression } =
        groups[0]?.Properties.Parameters ?? {};
      assert.deepEqual(
        { max_wal_size, checkpoint_timeout, wal_compression },
        { max_wal_size: '8192', checkpoint_timeout: '900', wal_compression: 'lz4' },
      );
    });
  }
});

describe('the load balancer’s reserved capacity', () => {
  const reservedOf = (stepName: string) => {
    const [balancer] = Object.values(
      appTemplateOf(stepName).findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'),
    );
    return balancer?.Properties.MinimumLoadBalancerCapacity;
  };

  it('leaves the load balancer to grow on its own where a step reserves nothing', () => {
    assert.equal(reservedOf('smoke'), undefined);
    assert.equal(reservedOf('step10'), undefined);
    assert.equal(reservedOf('step-prod'), undefined);
  });
});

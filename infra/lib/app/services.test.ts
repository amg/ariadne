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
      template.findResources('AWS::ApplicationAutoScaling::ScalingPolicy'),
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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { HOSTNAME, REGION } from '../../config/names.ts';
import { stepNamed } from '../../config/steps.ts';
import { CoreStack } from '../core/coreStack.ts';
import { AppStack } from './appStack.ts';

function appTemplate() {
  const app = new App();
  const env = { account: '123456789012', region: REGION };
  const core = new CoreStack(app, 'Core', { env });
  const stack = new AppStack(app, 'App', {
    env,
    step: stepNamed('smoke'),
    imageTag: 'test',
    seedSnapshot: 'seed-test',
    core: core.resources,
  });
  return Template.fromStack(stack);
}

const template = appTemplate();

/** The one distribution's configuration. */
function distributionConfig() {
  const [distribution, ...more] = Object.values(
    template.findResources('AWS::CloudFront::Distribution'),
  );
  assert.equal(more.length, 0);
  return distribution?.Properties.DistributionConfig;
}

describe('the front door', () => {
  it('keeps the load balancer off the internet, listening on plain HTTP inside the network', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internal',
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
    });
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TrustStore', 0);
  });

  it('lets only CloudFront’s VPC origin into the load balancer', () => {
    const [balancerGroup] = Object.values(
      template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'),
    ).map((balancer) => balancer.Properties.SecurityGroups[0]);
    const [lookup] = Object.keys(template.findResources('Custom::AWS'));
    const ingress = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')).filter(
      (rule) => JSON.stringify(rule.Properties.GroupId) === JSON.stringify(balancerGroup),
    );

    assert.equal(ingress.length, 1);
    assert.deepEqual(ingress[0]?.Properties, {
      Description: 'CloudFront VPC origin',
      IpProtocol: 'tcp',
      FromPort: 80,
      ToPort: 80,
      GroupId: balancerGroup,
      SourceSecurityGroupId: { 'Fn::GetAtt': [lookup, 'SecurityGroups.0.GroupId'] },
    });
  });

  it('serves the hostname, enforcing the edge’s web ACL', () => {
    const config = distributionConfig();

    assert.deepEqual(config.Aliases, [HOSTNAME]);
    assert.ok(config.WebACLId !== undefined);
  });

  it('passes the API through uncached and uncompressed, with every viewer header, and waits a minute for each part of an answer', () => {
    const config = distributionConfig();
    const api = config.CacheBehaviors.find(
      (behavior: { PathPattern: string }) => behavior.PathPattern === '/api/*',
    );

    assert.equal(api.Compress, false);
    // CloudFront's managed policies: caching disabled, and every viewer header forwarded.
    assert.equal(api.CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    assert.equal(api.OriginRequestPolicyId, '216adef6-5c7f-47e4-b989-5492eafa07d3');
    assert.equal(config.Origins[0].VpcOriginConfig.OriginReadTimeout, 60);
  });
});

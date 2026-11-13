import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { REGION } from '../../config/names.ts';
import { stepNamed } from '../../config/steps.ts';
import { CoreStack } from '../core/coreStack.ts';
import { LoadStack } from './loadStack.ts';

function loadTemplate() {
  const app = new App();
  const env = { account: '123456789012', region: REGION };
  const core = new CoreStack(app, 'Core', { env });
  const load = new LoadStack(app, 'Load', {
    env,
    step: stepNamed('smoke'),
    loadImageTag: 'test',
    core: core.resources,
  });
  return Template.fromStack(load);
}

describe('the load stack', () => {
  it('sends every generator out through one gateway with one public address the stack owns', () => {
    const template = loadTemplate();

    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.resourceCountIs('AWS::EC2::EIP', 1);
    const [addressId] = Object.keys(template.findResources('AWS::EC2::EIP'));
    template.hasResourceProperties('AWS::EC2::NatGateway', {
      AllocationId: { 'Fn::GetAtt': [addressId, 'AllocationId'] },
    });
  });

  it('names only private subnets for the generators, so a task cannot leave by another address', () => {
    const template = loadTemplate();

    const privateSubnets = Object.entries(template.findResources('AWS::EC2::Subnet'))
      .filter(([, subnet]) =>
        subnet.Properties.Tags.some(
          (tag: { Key: string; Value: string }) =>
            tag.Key === 'aws-cdk:subnet-type' && tag.Value === 'Private',
        ),
      )
      .map(([id]) => ({ Ref: id }));

    assert.equal(privateSubnets.length, 2);
    const [first, second] = privateSubnets;
    template.hasOutput('LoadSubnets', { Value: { 'Fn::Join': ['', [first, ',', second]] } });
  });

  it('lets nothing into the origin, since the generators go through the edge as users do', () => {
    const template = loadTemplate();

    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  });
});

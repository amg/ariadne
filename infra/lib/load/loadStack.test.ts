import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { REGION } from '../../config/names.ts';
import { stepNamed } from '../../config/steps.ts';
import { CoreStack } from '../core/coreStack.ts';
import { LoadStack } from './loadStack.ts';

type DirectPath = NonNullable<ConstructorParameters<typeof LoadStack>[2]['direct']>;

const DIRECT: DirectPath = {
  originAddress: 'origin.example.test',
  originSecurityGroup: 'sg-0123456789abcdef0',
};

function loadTemplate(direct?: DirectPath) {
  const app = new App();
  const env = { account: '123456789012', region: REGION };
  const core = new CoreStack(app, 'Core', { env });
  const load = new LoadStack(app, 'Load', {
    env,
    step: stepNamed('smoke'),
    loadImageTag: 'test',
    core: core.resources,
    direct,
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

  it('lets nothing into the origin when the run goes through Cloudflare', () => {
    const template = loadTemplate();

    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  });

  it('on the direct path, lets in its public address alone, on 443, to the origin’s security group', () => {
    const template = loadTemplate(DIRECT);

    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1);
    const [addressId] = Object.keys(template.findResources('AWS::EC2::EIP'));
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      GroupId: DIRECT.originSecurityGroup,
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      CidrIp: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [addressId, 'PublicIp'] }, '/32']] },
    });
  });

  it('on the direct path, tells the generators where the origin is', () => {
    const template = loadTemplate(DIRECT);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        Match.objectLike({
          Environment: Match.arrayWith([{ Name: 'ORIGIN_ADDRESS', Value: DIRECT.originAddress }]),
        }),
      ],
    });
  });
});

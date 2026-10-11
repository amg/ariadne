import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import {
  AVAILABILITY_ZONES,
  HOSTNAME,
  LOAD_KEY_HEADER,
  OUTPUTS,
  PARAMETERS,
  POPULATION,
} from '../../config/names.ts';
import type { Step } from '../../config/steps.ts';
import type { CoreResources } from '../core/coreStack.ts';
import { markLifetime } from '../lifetime.ts';

export type LoadStackProps = StackProps & {
  step: Step;
  imageTag: string;
  core: CoreResources;
};

/**
 * Load generators in their own network, reaching aws-prod the way users
 * do: over the internet, through Cloudflare. The stack holds only the
 * definition; the load command starts one task per generator and each
 * task exits when its run ends.
 */
export class LoadStack extends Stack {
  /** Pinned rather than looked up, so synthesis needs no AWS call. */
  override get availabilityZones(): string[] {
    return AVAILABILITY_ZONES;
  }

  constructor(scope: Construct, id: string, props: LoadStackProps) {
    super(scope, id, props);
    markLifetime(this, 'load');
    const { step, core } = props;

    const vpc = new ec2.Vpc(this, 'Vpc', {
      availabilityZones: AVAILABILITY_ZONES,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'generators', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 22 },
      ],
    });
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc,
      description: 'Load generators: outbound only',
    });
    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'Generator', {
      cpu: step.load.generator.cpu,
      memoryLimitMiB: step.load.generator.memoryMiB,
    });
    taskDefinition.addContainer('generator', {
      image: ecs.ContainerImage.fromEcrRepository(core.repositories.load, props.imageTag),
      environment: {
        TARGET_URL: `https://${HOSTNAME}`,
        LOAD_KEY_HEADER,
        EMAIL_DOMAIN: POPULATION.emailDomain,
        CHATTING_SHARE: String(step.load.chattingShare),
        RAMP_SECONDS: String(step.load.rampSeconds),
        HOLD_SECONDS: String(step.load.holdSeconds),
        THINK_SECONDS: String(step.load.thinkSeconds),
      },
      secrets: {
        LOAD_KEY: ecs.Secret.fromSsmParameter(
          ssm.StringParameter.fromSecureStringParameterAttributes(this, 'RunKey', {
            parameterName: PARAMETERS.runKey,
          }),
        ),
        USER_PASSWORD: ecs.Secret.fromSecretsManager(core.populationPassword),
      },
      ulimits: [{ name: ecs.UlimitName.NOFILE, softLimit: 1_048_576, hardLimit: 1_048_576 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'generator', logGroup }),
    });

    const outputs: Record<string, string> = {
      [OUTPUTS.loadCluster]: cluster.clusterName,
      [OUTPUTS.loadTaskDefinition]: taskDefinition.taskDefinitionArn,
      [OUTPUTS.loadSecurityGroup]: securityGroup.securityGroupId,
      [OUTPUTS.loadSubnets]: vpc.publicSubnets.map((subnet) => subnet.subnetId).join(','),
      [OUTPUTS.loadLogGroup]: logGroup.logGroupName,
    };
    for (const [key, value] of Object.entries(outputs)) new CfnOutput(this, key, { value });
  }
}

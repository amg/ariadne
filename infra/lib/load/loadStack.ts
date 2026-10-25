import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
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
import { KEPT_LOGS } from '../keptLogs.ts';
import { markLifetime } from '../lifetime.ts';
import type { CoreResources } from '../types/core.ts';

/** The longest Fargate lets a container take to stop, and as long as Spot's warning. */
const MOST_STOP_TIMEOUT_SECONDS = 120;

/** Where the generators reach the origin when they skip Cloudflare. */
type DirectPath = {
  /** The load balancer's address. */
  originAddress: string;
  /** The security group in front of the load balancer, which lets the generators in for the stack's life. */
  originSecurityGroup: string;
};

type LoadStackProps = StackProps & {
  step: Step;
  /** The tag of the generators' image, which need not be the one the app was raised with. */
  loadImageTag: string;
  core: CoreResources;
  /** Set for a run on the direct path; through Cloudflare otherwise. */
  direct?: DirectPath;
};

/**
 * Load generators in their own network, reaching aws-prod the way users
 * do: over the internet, through Cloudflare. The stack holds only the
 * definition; the load command starts one task per generator and each
 * task exits when its run ends. The cluster offers Fargate and Fargate
 * Spot, and the command picks one for each task it starts. Every
 * generator leaves the network from the stack's one public address.
 *
 * Given a direct path, the generators skip Cloudflare and present their
 * own client certificate to the load balancer. The stack lets its public
 * address into the origin's security group, so the way in lasts exactly as
 * long as the stack.
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

    const publicAddress = new ec2.CfnEIP(this, 'PublicAddress', { domain: 'vpc' });
    const vpc = new ec2.Vpc(this, 'Vpc', {
      availabilityZones: AVAILABILITY_ZONES,
      natGateways: 1,
      natGatewayProvider: ec2.NatProvider.gateway({
        eipAllocationIds: [publicAddress.attrAllocationId],
      }),
      subnetConfiguration: [
        { name: 'exit', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 28 },
        { name: 'generators', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
      ],
    });
    if (props.direct) {
      new ec2.CfnSecurityGroupIngress(this, 'DirectPath', {
        groupId: props.direct.originSecurityGroup,
        ipProtocol: 'tcp',
        fromPort: 443,
        toPort: 443,
        cidrIp: `${publicAddress.attrPublicIp}/32`,
        description: 'Load generators on the direct path',
      });
    }
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      enableFargateCapacityProviders: true,
      // Measures each generator's CPU and memory.
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc,
      description: 'Load generators: outbound only',
    });
    const logGroup = new logs.LogGroup(this, 'Logs', KEPT_LOGS);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'Generator', {
      cpu: step.load.generator.cpu,
      memoryLimitMiB: step.load.generator.memoryMiB,
    });
    taskDefinition.addContainer('generator', {
      // The whole of the two minutes Spot gives, so a reclaimed generator can write its report.
      stopTimeout: Duration.seconds(MOST_STOP_TIMEOUT_SECONDS),
      image: ecs.ContainerImage.fromEcrRepository(core.repositories.load, props.loadImageTag),
      environment: {
        TARGET_URL: `https://${HOSTNAME}`,
        LOAD_KEY_HEADER,
        EMAIL_DOMAIN: POPULATION.emailDomain,
        CHATTING_SHARE: String(step.load.chattingShare),
        RAMP_SECONDS: String(step.load.rampSeconds),
        HOLD_SECONDS: String(step.load.holdSeconds),
        THINK_SECONDS: String(step.load.thinkSeconds),
        // Each request and state line also publishes its figures as metrics.
        PUBLISH_METRICS: 'true',
        ...(props.direct ? { ORIGIN_ADDRESS: props.direct.originAddress } : {}),
      },
      secrets: {
        LOAD_KEY: secureParameter(this, 'RunKey', PARAMETERS.runKey),
        USER_PASSWORD: ecs.Secret.fromSecretsManager(core.populationPassword),
        ...(props.direct
          ? {
              ORIGIN_CLIENT_CERTIFICATE: secureParameter(
                this,
                'LoadClientCertificate',
                PARAMETERS.loadClientCertificate,
              ),
              ORIGIN_CLIENT_KEY: secureParameter(this, 'LoadClientKey', PARAMETERS.loadClientKey),
            }
          : {}),
      },
      ulimits: [{ name: ecs.UlimitName.NOFILE, softLimit: 1_048_576, hardLimit: 1_048_576 }],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'generator', logGroup }),
    });

    const outputs: Record<string, string> = {
      [OUTPUTS.loadCluster]: cluster.clusterName,
      [OUTPUTS.loadTaskDefinition]: taskDefinition.taskDefinitionArn,
      [OUTPUTS.loadSecurityGroup]: securityGroup.securityGroupId,
      [OUTPUTS.loadSubnets]: vpc.privateSubnets.map((subnet) => subnet.subnetId).join(','),
      [OUTPUTS.loadLogGroup]: logGroup.logGroupName,
    };
    for (const [key, value] of Object.entries(outputs)) new CfnOutput(this, key, { value });
  }
}

function secureParameter(scope: Construct, id: string, parameterName: string) {
  return ecs.Secret.fromSsmParameter(
    ssm.StringParameter.fromSecureStringParameterAttributes(scope, id, { parameterName }),
  );
}

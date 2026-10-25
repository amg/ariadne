import { Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import type { DeployPolicy, ServiceConfig } from '../../config/steps.ts';
import { KEPT_LOGS } from '../keptLogs.ts';
import { SUBNETS } from './network.ts';

type AppServiceProps = {
  cluster: ecs.ICluster;
  image: ecs.ContainerImage;
  size: ServiceConfig;
  /** How a deploy replaces this service's tasks. */
  deploy: DeployPolicy;
  /** Port to expose. Omit for workers/background tasks that don't accept connections. */
  port?: number;
  command?: string[];
  environment?: Record<string, string>;
  secrets?: Record<string, ecs.Secret>;
  /** Registers `<name>.<internal domain>` so other services can find this one. */
  discoveryName?: string;
  /** Kernel settings of the task's own network, beyond the platform's defaults. */
  systemControls?: ecs.SystemControl[];
};

/** Long-lived streams hold many sockets open in one process. */
const OPEN_FILES = 65_536;

/**
 * One container per task on Fargate, in the private app subnets, with its
 * own log group and security group. A deploy that never turns healthy
 * rolls itself back.
 */
export class AppService extends Construct {
  readonly service: ecs.FargateService;
  readonly port: number;

  constructor(scope: Construct, id: string, props: AppServiceProps) {
    super(scope, id);
    this.port = props.port ?? 0;

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: props.size.cpu,
      memoryLimitMiB: props.size.memoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    taskDefinition.addContainer('main', {
      image: props.image,
      command: props.command,
      environment: props.environment ?? {},
      secrets: props.secrets ?? {},
      portMappings: props.port !== undefined ? [{ containerPort: props.port }] : [],
      ulimits: [{ name: ecs.UlimitName.NOFILE, softLimit: OPEN_FILES, hardLimit: OPEN_FILES }],
      systemControls: props.systemControls,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: id.toLowerCase(),
        logGroup: new logs.LogGroup(this, 'Logs', KEPT_LOGS),
      }),
    });

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition,
      // A scaling service's count belongs to the autoscaler; setting it would
      // reset the count to the floor on every deploy.
      desiredCount: props.size.scaling === undefined ? props.size.count : undefined,
      vpcSubnets: SUBNETS.app,
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      minHealthyPercent: props.deploy.minHealthyPercent,
      maxHealthyPercent: props.deploy.maxHealthyPercent,
      cloudMapOptions:
        props.discoveryName === undefined
          ? undefined
          : {
              name: props.discoveryName,
              dnsRecordType: servicediscovery.DnsRecordType.A,
              dnsTtl: Duration.seconds(10),
            },
    });

    const { scaling } = props.size;
    if (scaling !== undefined) {
      const taskCount = this.service.autoScaleTaskCount({
        minCapacity: props.size.count,
        maxCapacity: scaling.maxCount,
      });
      const cooldowns = {
        scaleInCooldown: Duration.seconds(scaling.scaleInCooldown ?? 300),
        scaleOutCooldown: Duration.seconds(scaling.scaleOutCooldown ?? 60),
      };
      if (scaling.targetCpuPercent !== undefined) {
        taskCount.scaleOnCpuUtilization('CpuScaling', {
          targetUtilizationPercent: scaling.targetCpuPercent,
          ...cooldowns,
        });
      }
      if (scaling.targetMemoryPercent !== undefined) {
        taskCount.scaleOnMemoryUtilization('MemoryScaling', {
          targetUtilizationPercent: scaling.targetMemoryPercent,
          ...cooldowns,
        });
      }
    }
  }

  /** Lets `peer` open connections to this service's port. No-op if no port is declared. */
  acceptFrom(peer: ec2.IConnectable): void {
    if (this.port === 0) return;
    this.service.connections.allowFrom(peer, ec2.Port.tcp(this.port));
  }
}

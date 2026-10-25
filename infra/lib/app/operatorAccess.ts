import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { DATABASE, PORTS } from '../../config/names.ts';
import { KEPT_LOGS } from '../keptLogs.ts';
import type { Cache } from './cache.ts';
import type { Database } from './database.ts';
import { type Network, SUBNETS } from './network.ts';

/**
 * The only ways a person or a script reaches inside: an SSM session through
 * a bastion that opens no ports, and the one-off warm-up task that reads
 * a freshly restored database before load starts.
 */
export class OperatorAccess extends Construct {
  readonly bastion: ec2.BastionHostLinux;
  readonly warmTask: ecs.FargateTaskDefinition;
  readonly warmSecurityGroup: ec2.SecurityGroup;

  constructor(
    scope: Construct,
    id: string,
    props: {
      network: Network;
      database: Database;
      cache: Cache;
      toolsRepository: ecr.IRepository;
      imageTag: string;
    },
  ) {
    super(scope, id);
    const { network, database, cache } = props;

    this.bastion = new ec2.BastionHostLinux(this, 'Bastion', {
      vpc: network.vpc,
      subnetSelection: SUBNETS.app,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(8, { encrypted: true }),
        },
      ],
    });
    database.connections.allowDefaultPortFrom(this.bastion);
    cache.connections.allowDefaultPortFrom(this.bastion);

    this.warmTask = new ecs.FargateTaskDefinition(this, 'WarmTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    this.warmTask.addContainer('warm', {
      image: ecs.ContainerImage.fromEcrRepository(props.toolsRepository, props.imageTag),
      environment: {
        PGHOST: database.instance.dbInstanceEndpointAddress,
        PGPORT: String(PORTS.postgres),
        PGDATABASE: DATABASE.name,
      },
      secrets: {
        PGUSER: ecs.Secret.fromSecretsManager(database.secret, 'username'),
        PGPASSWORD: ecs.Secret.fromSecretsManager(database.secret, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'warm',
        logGroup: new logs.LogGroup(this, 'WarmLogs', KEPT_LOGS),
      }),
    });
    this.warmSecurityGroup = new ec2.SecurityGroup(this, 'WarmSecurityGroup', { vpc: network.vpc });
    database.connections.allowDefaultPortFrom(this.warmSecurityGroup);
  }
}

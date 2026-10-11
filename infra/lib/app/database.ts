import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { DATABASE, PARAMETERS } from '../../config/names.ts';
import type { Step } from '../../config/steps.ts';
import { type Network, SUBNETS } from './network.ts';

const ENGINE = rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 });

/**
 * One Postgres instance at a fixed size on gp3, so its hourly cost is
 * known and nothing reads its own write from a lagging replica. No
 * standby, no backups, no deletion protection: it holds nothing worth
 * keeping and every raise rebuilds it.
 */
export class Database extends Construct {
  readonly instance: rds.IDatabaseInstance;
  readonly secret: secretsmanager.ISecret;
  readonly connections: ec2.Connections;

  constructor(scope: Construct, id: string, props: { network: Network; step: Step }) {
    super(scope, id);
    const { network, step } = props;

    const shape = {
      engine: ENGINE,
      instanceType: new ec2.InstanceType(step.database.instanceClass),
      vpc: network.vpc,
      vpcSubnets: SUBNETS.data,
      allocatedStorage: step.database.storageGiB,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      backupRetention: Duration.days(0),
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      enablePerformanceInsights: true,
      parameterGroup: new rds.ParameterGroup(this, 'Parameters', {
        engine: ENGINE,
        parameters: { 'rds.force_ssl': '1' },
      }),
    };

    const instance =
      step.database.source === 'empty'
        ? new rds.DatabaseInstance(this, 'Instance', {
            ...shape,
            databaseName: DATABASE.name,
            credentials: rds.Credentials.fromGeneratedSecret(DATABASE.masterUser),
          })
        : new rds.DatabaseInstanceFromSnapshot(this, 'Instance', {
            ...shape,
            snapshotIdentifier: ssm.StringParameter.valueForStringParameter(
              this,
              PARAMETERS.seedSnapshotId,
            ),
            credentials: rds.SnapshotCredentials.fromGeneratedSecret(DATABASE.masterUser),
          });

    if (instance.secret === undefined)
      throw new Error('The database must carry a generated secret');
    this.instance = instance;
    this.secret = instance.secret;
    this.connections = instance.connections;
  }
}

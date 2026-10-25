import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import {
  type ImageName,
  OUTPUTS,
  PROJECT,
  repositoryName,
  vaultBucketName,
} from '../../config/names.ts';
import { markLifetime } from '../lifetime.ts';
import type { CoreResources } from '../types/core.ts';
import { LoadDashboard } from './loadDashboard.ts';
import { SafetyNet } from './safetyNet.ts';

/**
 * What aws-prod keeps while it is down: a few dollars a month. Data in the
 * vault and images survive a teardown; nothing here serves traffic.
 */
export class CoreStack extends Stack {
  readonly resources: CoreResources;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    markLifetime(this, 'core');

    const vault = new s3.Bucket(this, 'Vault', {
      bucketName: vaultBucketName(this.account),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.resources = {
      vault,
      repositories: imageRepositories(this),
      authApiKey: generatedSecret(this, 'AuthApiKey', `${PROJECT}/auth-api-key`),
      populationPassword: generatedSecret(
        this,
        'PopulationPassword',
        `${PROJECT}/population-password`,
      ),
    };

    new SafetyNet(this, 'SafetyNet');
    new LoadDashboard(this, 'LoadDashboard');
    new CfnOutput(this, OUTPUTS.vaultBucket, { value: vault.bucketName });
  }
}

function imageRepositories(scope: Construct): Record<ImageName, ecr.IRepository> {
  const repositoryFor = (image: ImageName) =>
    new ecr.Repository(scope, `Repository-${image}`, {
      repositoryName: repositoryName(image),
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 10 }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
  return {
    backend: repositoryFor('backend'),
    web: repositoryFor('web'),
    auth: repositoryFor('auth'),
    tools: repositoryFor('tools'),
    load: repositoryFor('load'),
  };
}

/** Letters and digits only: both the auth core and the sign-in form accept them unescaped. */
function generatedSecret(scope: Construct, id: string, name: string): secretsmanager.ISecret {
  return new secretsmanager.Secret(scope, id, {
    secretName: name,
    generateSecretString: { passwordLength: 40, excludePunctuation: true },
    removalPolicy: RemovalPolicy.RETAIN,
  });
}

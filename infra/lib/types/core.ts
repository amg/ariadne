import type * as ecr from 'aws-cdk-lib/aws-ecr';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { ImageName } from '../../config/names.ts';

/** What the app and load stacks take from core. */
export type CoreResources = {
  vault: s3.IBucket;
  repositories: Record<ImageName, ecr.IRepository>;
  /** Shared by the backend and the auth core. */
  authApiKey: secretsmanager.ISecret;
  /** The one password every synthetic account signs in with. */
  populationPassword: secretsmanager.ISecret;
};

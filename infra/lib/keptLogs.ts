import { RemovalPolicy } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';

/** Every log group of a raise is kept for a month after its stack is deleted. */
export const KEPT_LOGS = {
  retention: logs.RetentionDays.ONE_MONTH,
  removalPolicy: RemovalPolicy.RETAIN,
} as const;

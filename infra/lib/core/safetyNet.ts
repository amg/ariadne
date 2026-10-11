import { DefaultStackSynthesizer, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { SAFETY_NET, STACKS } from '../../config/names.ts';
import type { StackLimit } from './safetyNetHandler.ts';

const CHECK_EVERY = Duration.minutes(5);

/**
 * Deletes the app stack three hours after a raise and the load stack an
 * hour after it starts, whoever forgot them. It never touches Cloudflare:
 * a record left pointing at a deleted load balancer only serves errors.
 */
export class SafetyNet extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const stack = Stack.of(this);

    const limits: StackLimit[] = [
      { stackName: STACKS.load, maxAgeMinutes: SAFETY_NET.loadMinutes },
      { stackName: STACKS.app, maxAgeMinutes: SAFETY_NET.appMinutes },
    ];

    const sweeper = new NodejsFunction(this, 'Sweeper', {
      entry: new URL('./safetyNetHandler.ts', import.meta.url).pathname,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.minutes(1),
      environment: { STACK_LIMITS: JSON.stringify(limits) },
      logGroup: new logs.LogGroup(this, 'Logs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    const stackArns = limits.map(
      ({ stackName }) =>
        `arn:aws:cloudformation:${stack.region}:${stack.account}:stack/${stackName}/*`,
    );
    sweeper.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks', 'cloudformation:DeleteStack'],
        resources: stackArns,
      }),
    );
    // A stack deploys through CDK's execution role, and deleting it goes through that role too.
    sweeper.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [
          `arn:aws:iam::${stack.account}:role/cdk-${DefaultStackSynthesizer.DEFAULT_QUALIFIER}-cfn-exec-role-${stack.account}-${stack.region}`,
        ],
      }),
    );

    new events.Rule(this, 'Schedule', {
      schedule: events.Schedule.rate(CHECK_EVERY),
      targets: [new targets.LambdaFunction(sweeper)],
    });
  }
}

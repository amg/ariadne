import { DefaultStackSynthesizer, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EDGE_REGION, SAFETY_NET, STACKS } from '../../config/names.ts';
import type { StackLimit } from './safetyNetHandler.ts';

const CHECK_EVERY = Duration.minutes(5);

/**
 * Deletes the app stack and its edge rules four hours after a raise, and
 * the load stack 150 minutes after it starts, whoever forgot them. The edge
 * rules cannot go while the app's distribution still uses them, so their
 * deletion fails until the app stack is gone, and the next check tries
 * again. It never touches Cloudflare: a record left pointing at a deleted
 * distribution only serves errors.
 */
export class SafetyNet extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const stack = Stack.of(this);

    const limits: StackLimit[] = [
      { stackName: STACKS.load, region: stack.region, maxAgeMinutes: SAFETY_NET.loadMinutes },
      { stackName: STACKS.app, region: stack.region, maxAgeMinutes: SAFETY_NET.appMinutes },
      { stackName: STACKS.edgeRules, region: EDGE_REGION, maxAgeMinutes: SAFETY_NET.appMinutes },
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
      ({ stackName, region }) =>
        `arn:aws:cloudformation:${region}:${stack.account}:stack/${stackName}/*`,
    );
    const regions = [...new Set(limits.map(({ region }) => region))];
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
        resources: regions.map(
          (region) =>
            `arn:aws:iam::${stack.account}:role/cdk-${DefaultStackSynthesizer.DEFAULT_QUALIFIER}-cfn-exec-role-${stack.account}-${region}`,
        ),
      }),
    );

    new events.Rule(this, 'Schedule', {
      schedule: events.Schedule.rate(CHECK_EVERY),
      targets: [new targets.LambdaFunction(sweeper)],
    });
  }
}

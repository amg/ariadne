import { Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { HOSTNAME } from '../../config/names.ts';
import type { AppService } from './appService.ts';
import { type Network, SUBNETS } from './network.ts';

/** Longer than the push stream's heartbeat, so an idle tab is never cut. */
const IDLE_TIMEOUT = Duration.seconds(120);

/**
 * The private load balancer behind CloudFront. It has no public address,
 * and two locks, each independent: only what its security group is told to
 * admit may connect, and only requests for aws-prod's hostname are routed
 * anywhere. CloudFront ends TLS at its edge, so the load balancer speaks
 * plain HTTP inside the network.
 */
export class Origin extends Construct {
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;

  constructor(
    scope: Construct,
    id: string,
    props: {
      network: Network;
      vault: s3.IBucket;
      api: AppService;
      web: AppService;
      /** Capacity units kept reserved for the raise's whole life; null leaves the load balancer to grow on its own. */
      reservedCapacityUnits: number | null;
    },
  ) {
    super(scope, id);

    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.network.vpc,
      description: 'Origin: HTTP from CloudFront only',
      allowAllOutbound: false,
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: props.network.vpc,
      vpcSubnets: SUBNETS.edge,
      internetFacing: false,
      securityGroup,
      idleTimeout: IDLE_TIMEOUT,
      dropInvalidHeaderFields: true,
      minimumCapacityUnit: props.reservedCapacityUnits ?? undefined,
    });
    this.loadBalancer.logAccessLogs(props.vault, 'origin-access-logs');

    const listener = this.loadBalancer.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.fixedResponse(421, {
        contentType: 'text/plain',
        messageBody: 'Misdirected request',
      }),
      open: false,
    });

    listener.addTargets('Api', {
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([HOSTNAME]),
        elbv2.ListenerCondition.pathPatterns(['/api/*']),
      ],
      port: props.api.port,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [props.api.service],
      // An API task that is overloaded answers slowly but still answers. It is
      // removed only after five missed checks, about two and a half minutes,
      // which is long enough for scaling to add tasks beside it.
      healthCheck: {
        path: '/api/health',
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        unhealthyThresholdCount: 5,
      },
      deregistrationDelay: Duration.seconds(30),
    });

    listener.addTargets('Web', {
      priority: 20,
      conditions: [elbv2.ListenerCondition.hostHeaders([HOSTNAME])],
      port: props.web.port,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [props.web.service],
      healthCheck: { path: '/', healthyHttpCodes: '200' },
      deregistrationDelay: Duration.seconds(10),
    });
  }
}

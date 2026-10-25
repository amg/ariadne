import { Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { CLOUDFLARE_IPV4_RANGES } from '../../config/cloudflareRanges.ts';
import { HOSTNAME, ORIGIN_TRUST_KEY, PARAMETERS } from '../../config/names.ts';
import type { AppService } from './appService.ts';
import { type Network, SUBNETS } from './network.ts';

/** Longer than the push stream's heartbeat, so an idle tab is never cut. */
const IDLE_TIMEOUT = Duration.seconds(120);

/**
 * The public load balancer Cloudflare proxies to. Three locks, each
 * independent: only Cloudflare's address ranges may connect, only a
 * client presenting aws-prod's own certificate completes the handshake,
 * and only requests for aws-prod's hostname are routed anywhere.
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
      description: 'Origin: HTTPS from Cloudflare only',
      allowAllOutbound: false,
    });
    for (const range of CLOUDFLARE_IPV4_RANGES) {
      securityGroup.addIngressRule(ec2.Peer.ipv4(range), ec2.Port.HTTPS, 'Cloudflare');
    }

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: props.network.vpc,
      vpcSubnets: SUBNETS.edge,
      internetFacing: true,
      securityGroup,
      idleTimeout: IDLE_TIMEOUT,
      dropInvalidHeaderFields: true,
      minimumCapacityUnit: props.reservedCapacityUnits ?? undefined,
    });
    this.loadBalancer.logAccessLogs(props.vault, 'origin-access-logs');

    const listener = this.loadBalancer.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      certificates: [originCertificate(this)],
      mutualAuthentication: {
        mutualAuthenticationMode: elbv2.MutualAuthenticationMode.VERIFY,
        trustStore: new elbv2.TrustStore(this, 'ClientTrust', {
          bucket: props.vault,
          key: ORIGIN_TRUST_KEY,
        }),
      },
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
      healthCheck: { path: '/api/health', healthyHttpCodes: '200' },
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

/** Cloudflare's origin certificate, imported once into ACM by the core command. */
function originCertificate(scope: Construct) {
  const arn = ssm.StringParameter.valueForStringParameter(scope, PARAMETERS.originCertificateArn);
  return elbv2.ListenerCertificate.fromArn(arn);
}

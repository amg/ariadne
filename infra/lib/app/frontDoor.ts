import { Duration } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { HOSTNAME, PARAMETERS } from '../../config/names.ts';
import type { Network } from './network.ts';
import type { Origin } from './origin.ts';

/** The security group CloudFront makes in a network for its VPC origins. */
const VPC_ORIGINS_SECURITY_GROUP = 'CloudFront-VPCOrigins-Service-SG';

/**
 * How long the edge waits for the next part of an answer. Above the push
 * stream's heartbeat and the gate and handover waits, so a quiet stream or
 * a waiting chat is never cut.
 */
const ORIGIN_READ_TIMEOUT = Duration.seconds(60);

/**
 * How long the edge keeps an idle connection to the load balancer open.
 * Below the load balancer's own idle timeout, so the load balancer never
 * closes a connection the edge is about to reuse.
 */
const ORIGIN_KEEPALIVE = Duration.seconds(60);

/**
 * CloudFront in front of the private load balancer: TLS for the hostname,
 * the web app's static files cached by their own `Cache-Control`, and the
 * API passed through uncached. The edge's web ACL decides who gets in.
 * Users' handshakes end at the edge, and their short requests share the
 * edge's open connections to the load balancer.
 */
export class FrontDoor extends Construct {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: { network: Network; origin: Origin }) {
    super(scope, id);
    const { network, origin } = props;

    const loadBalancer = origins.VpcOrigin.withApplicationLoadBalancer(origin.loadBalancer, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      readTimeout: ORIGIN_READ_TIMEOUT,
      keepaliveTimeout: ORIGIN_KEEPALIVE,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: [HOSTNAME],
      certificate: acm.Certificate.fromCertificateArn(
        this,
        'Certificate',
        ssm.StringParameter.valueForStringParameter(this, PARAMETERS.edgeCertificateArn),
      ),
      webAclId: ssm.StringParameter.valueForStringParameter(this, PARAMETERS.webAclArn),
      // The allow-list names the operator by an IPv4 address.
      enableIpv6: false,
      publishAdditionalMetrics: true,
      defaultBehavior: {
        origin: loadBalancer,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Keys the cache on the Host header too, which the load balancer routes on.
        cachePolicy: cloudfront.CachePolicy.USE_ORIGIN_CACHE_CONTROL_HEADERS,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: loadBalancer,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
          // A compressed stream is held back until a block fills.
          compress: false,
        },
      },
    });

    // CloudFormation does not name the group CloudFront makes, so it is looked up once the distribution exists.
    const vpcOriginsGroup = new cr.AwsCustomResource(this, 'VpcOriginsSecurityGroup', {
      onCreate: {
        service: 'ec2',
        action: 'describeSecurityGroups',
        parameters: {
          Filters: [
            { Name: 'vpc-id', Values: [network.vpc.vpcId] },
            { Name: 'group-name', Values: [VPC_ORIGINS_SECURITY_GROUP] },
          ],
        },
        physicalResourceId: cr.PhysicalResourceId.of(VPC_ORIGINS_SECURITY_GROUP),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });
    vpcOriginsGroup.node.addDependency(this.distribution);
    origin.loadBalancer.connections.allowFrom(
      ec2.SecurityGroup.fromSecurityGroupId(
        this,
        'VpcOrigins',
        vpcOriginsGroup.getResponseField('SecurityGroups.0.GroupId'),
        { mutable: false },
      ),
      ec2.Port.HTTP,
      'CloudFront VPC origin',
    );
  }
}

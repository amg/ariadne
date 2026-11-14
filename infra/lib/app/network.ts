import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { AVAILABILITY_ZONES } from '../../config/names.ts';
import { KEPT_LOGS } from '../keptLogs.ts';
import { INTERFACE_ENDPOINT_COUNT } from '../worstCase.ts';

/**
 * AWS services the app reaches privately. Nothing inside starts a
 * connection to the internet, so there is no NAT gateway: images, logs,
 * secrets and the bastion's session all travel through these.
 */
const INTERFACE_ENDPOINTS: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
  EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
  EcrDocker: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
  Logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
  Secrets: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
  Ssm: ec2.InterfaceVpcEndpointAwsService.SSM,
  SsmMessages: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
  Ec2Messages: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
};

/** The three subnet tiers, each in both availability zones. */
export const SUBNETS = {
  /** The load balancer, which CloudFront reaches through its VPC origin. */
  edge: { subnetGroupName: 'edge' },
  /** Services, the bastion and the endpoints. */
  app: { subnetGroupName: 'app' },
  /** The database and the cache. */
  data: { subnetGroupName: 'data' },
} satisfies Record<string, ec2.SubnetSelection>;

/** The app's private network, spread over both availability zones. */
export class Network extends Construct {
  readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    if (Object.keys(INTERFACE_ENDPOINTS).length !== INTERFACE_ENDPOINT_COUNT) {
      throw new Error('INTERFACE_ENDPOINT_COUNT is out of step with the endpoints created');
    }

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      availabilityZones: AVAILABILITY_ZONES,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'edge', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 20 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
      flowLogs: {
        Rejected: {
          trafficType: ec2.FlowLogTrafficType.REJECT,
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, 'FlowLogs', KEPT_LOGS),
          ),
        },
      },
    });

    // CloudFront creates a VPC origin only in a network with an internet
    // gateway attached, as the sign that the network may take traffic from
    // the internet. That traffic reaches the load balancer through CloudFront's
    // own network interfaces, never through the gateway. No subnet routes to
    // the gateway, so nothing inside can reach the internet or be reached
    // from it. It is not a NAT gateway.
    const gateway = new ec2.CfnInternetGateway(this, 'InternetGateway');
    new ec2.CfnVPCGatewayAttachment(this, 'InternetGatewayAttachment', {
      vpcId: this.vpc.vpcId,
      internetGatewayId: gateway.ref,
    });

    for (const [name, service] of Object.entries(INTERFACE_ENDPOINTS)) {
      this.vpc.addInterfaceEndpoint(name, {
        service,
        subnets: SUBNETS.app,
        privateDnsEnabled: true,
      });
    }
  }
}

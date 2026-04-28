import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

interface PrivateLinkStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  kmsKey: kms.Key;
  apiGwVpcEndpoint: ec2.InterfaceVpcEndpoint;
  // List of consumer account principals allowed to connect (e.g. 'arn:aws:iam::123456789012:root')
  allowedConsumerPrincipals?: iam.ArnPrincipal[];
}

export class PrivateLinkStack extends cdk.Stack {
  public readonly endpointServiceName: string;
  public readonly nlbFullName: string;

  constructor(scope: Construct, id: string, props: PrivateLinkStackProps) {
    super(scope, id, props);

    // ─── Step 1: Resolve the private IPs of the execute-api VPC endpoint ENIs ──
    //
    // The execute-api VPC endpoint creates one ENI per AZ. We need those IPs
    // as NLB targets. Two chained AwsCustomResources do this at deploy time
    // without requiring an EC2 VPC endpoint (these Lambdas run outside the VPC).

    const endpointDetails = new cr.AwsCustomResource(this, 'GetEndpointDetails', {
      onUpdate: {
        service: 'EC2',
        action: 'describeVpcEndpoints',
        parameters: {
          VpcEndpointIds: [props.apiGwVpcEndpoint.vpcEndpointId],
        },
        physicalResourceId: cr.PhysicalResourceId.of(props.apiGwVpcEndpoint.vpcEndpointId),
        // Filter response to only the fields we read - keeps the CFN custom
        // resource payload under the 4 KB limit.
        outputPaths: [
          'VpcEndpoints.0.NetworkInterfaceIds.0',
          'VpcEndpoints.0.NetworkInterfaceIds.1',
          'VpcEndpoints.0.NetworkInterfaceIds.2',
        ],
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });

    // Network interface IDs — one per AZ (3 AZs as configured in NetworkingStack)
    const ni0Id = endpointDetails.getResponseField('VpcEndpoints.0.NetworkInterfaceIds.0');
    const ni1Id = endpointDetails.getResponseField('VpcEndpoints.0.NetworkInterfaceIds.1');
    const ni2Id = endpointDetails.getResponseField('VpcEndpoints.0.NetworkInterfaceIds.2');

    const niDetails = new cr.AwsCustomResource(this, 'GetNiDetails', {
      onUpdate: {
        service: 'EC2',
        action: 'describeNetworkInterfaces',
        parameters: {
          NetworkInterfaceIds: [ni0Id, ni1Id, ni2Id],
        },
        physicalResourceId: cr.PhysicalResourceId.of(
          `${props.apiGwVpcEndpoint.vpcEndpointId}-nis`,
        ),
        // Filter response: NetworkInterfaces is otherwise huge (full attachment,
        // SG, VPC, subnet detail per ENI) and exceeds the 4 KB CFN custom
        // resource payload limit.
        outputPaths: [
          'NetworkInterfaces.0.PrivateIpAddress',
          'NetworkInterfaces.1.PrivateIpAddress',
          'NetworkInterfaces.2.PrivateIpAddress',
        ],
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });

    // niDetails depends on endpointDetails resolving the NI IDs
    niDetails.node.addDependency(endpointDetails);

    const ip0 = niDetails.getResponseField('NetworkInterfaces.0.PrivateIpAddress');
    const ip1 = niDetails.getResponseField('NetworkInterfaces.1.PrivateIpAddress');
    const ip2 = niDetails.getResponseField('NetworkInterfaces.2.PrivateIpAddress');

    // ─── Step 2: Internal NLB targeting the execute-api endpoint ENI IPs ───────

    const nlb = new elbv2.NetworkLoadBalancer(this, 'PrivateLinkNlb', {
      vpc: props.vpc,
      internetFacing: false,
      loadBalancerName: 'cloud-acceleration-pl-nlb',
      crossZoneEnabled: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    const listener = nlb.addListener('TlsListener', {
      port: 443,
      protocol: elbv2.Protocol.TCP,
    });

    // IP targets — one per AZ, pointing at the execute-api VPC endpoint ENIs
    listener.addTargets('ApiGwEndpointTargets', {
      port: 443,
      protocol: elbv2.Protocol.TCP,
      targetGroupName: 'cloud-accel-apigw-targets',
      targets: [
        new elbv2Targets.IpTarget(ip0, 443),
        new elbv2Targets.IpTarget(ip1, 443),
        new elbv2Targets.IpTarget(ip2, 443),
      ],
      healthCheck: {
        enabled: true,
        port: '443',
        protocol: elbv2.Protocol.TCP,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        interval: cdk.Duration.seconds(10),
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ─── Step 3: VPC Endpoint Service (PrivateLink) ──────────────────────────
    //
    // acceptanceRequired: true means each new consumer connection request must
    // be manually approved — satisfies NIST AC-3 (access enforcement).

    const endpointService = new ec2.VpcEndpointService(this, 'ApiEndpointService', {
      vpcEndpointServiceLoadBalancers: [nlb],
      acceptanceRequired: true,
      allowedPrincipals: props.allowedConsumerPrincipals,
    });

    // Expose the service name so consumers can create VPC Interface Endpoints
    this.endpointServiceName = endpointService.vpcEndpointServiceName;
    // Full NLB name used as a CloudWatch dimension for metrics
    this.nlbFullName = nlb.loadBalancerFullName;

    // ─── Outputs ─────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'EndpointServiceName', {
      value: endpointService.vpcEndpointServiceName,
      description: 'Share this with consumer accounts to create their VPC Interface Endpoint',
    });

    new cdk.CfnOutput(this, 'NlbArn', {
      value: nlb.loadBalancerArn,
    });

    new cdk.CfnOutput(this, 'ConsumerSetupInstructions', {
      value: [
        '1. Share the EndpointServiceName with the consumer account.',
        '2. Consumer creates a VPC Interface Endpoint in their VPC:',
        '   aws ec2 create-vpc-endpoint --vpc-id <vpc-id>',
        '     --vpc-endpoint-type Interface',
        `     --service-name ${endpointService.vpcEndpointServiceName}`,
        '     --subnet-ids <private-subnet-ids>',
        '     --security-group-ids <sg-id>',
        '3. Approve the connection request in this account:',
        '   aws ec2 accept-vpc-endpoint-connections',
        `     --service-id ${endpointService.vpcEndpointServiceId}`,
        '     --vpc-endpoint-ids <consumer-endpoint-id>',
        '4. Consumer invokes the API using:',
        '   https://<api-id>.execute-api.<region>.amazonaws.com/v1',
        '   Host: <api-id>.execute-api.<region>.amazonaws.com',
        '   (send via the endpoint DNS, not the public hostname)',
      ].join(' '),
      description: 'Step-by-step consumer setup instructions',
    });
  }
}

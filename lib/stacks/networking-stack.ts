import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { LOG_RETENTION } from '../constants';

interface NetworkingStackProps extends cdk.StackProps {
  kmsKey: kms.Key;
}

const INTERFACE_ENDPOINTS: Array<{ id: string; service: ec2.InterfaceVpcEndpointAwsService }> = [
  { id: 'LambdaEndpoint',           service: ec2.InterfaceVpcEndpointAwsService.LAMBDA },
  { id: 'CloudWatchEndpoint',       service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH },
  { id: 'CloudWatchLogsEndpoint',   service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS },
  { id: 'CloudWatchEventsEndpoint', service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_EVENTS },
  { id: 'SecretsManagerEndpoint',   service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER },
  { id: 'KmsEndpoint',              service: ec2.InterfaceVpcEndpointAwsService.KMS },
  { id: 'StsEndpoint',              service: ec2.InterfaceVpcEndpointAwsService.STS },
  { id: 'SnsEndpoint',              service: ec2.InterfaceVpcEndpointAwsService.SNS },
  { id: 'SsmEndpoint',              service: ec2.InterfaceVpcEndpointAwsService.SSM },
];

export class NetworkingStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly apiGwVpcEndpoint: ec2.InterfaceVpcEndpoint;

  constructor(scope: Construct, id: string, props: NetworkingStackProps) {
    super(scope, id, props);

    // Fully private VPC — no internet gateway, no NAT gateway (NIST SC-7)
    this.vpc = new ec2.Vpc(this, 'PrivateVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'private-isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    // VPC Flow Logs — NIST AU-12: network audit trail
    const flowLogGroup = new logs.LogGroup(this, 'VpcFlowLogs', {
      logGroupName: '/cloud-acceleration/vpc-flow-logs',
      retention: LOG_RETENTION,
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new ec2.FlowLog(this, 'FlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // Security group for VPC endpoints — accepts HTTPS from within the VPC
    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: this.vpc,
      description: 'VPC Interface Endpoints - HTTPS ingress from VPC CIDR only',
      allowAllOutbound: false,
    });
    endpointSg.addIngressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcp(443), 'HTTPS from VPC');

    // API Gateway endpoint is exported — create separately so it can be referenced by ApiStack
    this.apiGwVpcEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ApiGwEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });

    // All other interface endpoints share the same security group and settings
    for (const { id, service } of INTERFACE_ENDPOINTS) {
      new ec2.InterfaceVpcEndpoint(this, id, {
        vpc: this.vpc,
        service,
        securityGroups: [endpointSg],
        privateDnsEnabled: true,
      });
    }

    // DynamoDB gateway endpoint — free, no data traverses internet
    new ec2.GatewayVpcEndpoint(this, 'DynamoDbEndpoint', {
      vpc: this.vpc,
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}

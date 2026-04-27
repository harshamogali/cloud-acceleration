import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface NetworkingStackProps extends cdk.StackProps {
  kmsKey: kms.Key;
}

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
      retention: logs.RetentionDays.ONE_YEAR,
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new ec2.FlowLog(this, 'FlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // Security group for Lambda functions
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'Security group for Lambda functions — no inbound',
      allowAllOutbound: false,
    });
    lambdaSg.addEgressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcp(443), 'HTTPS to VPC endpoints only');

    // Security group for VPC endpoints
    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: this.vpc,
      description: 'Security group for VPC Interface Endpoints',
      allowAllOutbound: false,
    });
    endpointSg.addIngressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcp(443), 'HTTPS from VPC');

    // VPC Endpoints — all AWS service traffic stays within the AWS network (NIST SC-7, SC-8)
    this.apiGwVpcEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ApiGwEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });

    new ec2.InterfaceVpcEndpoint(this, 'LambdaEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.LAMBDA,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });

    new ec2.InterfaceVpcEndpoint(this, 'CloudWatchEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });

    new ec2.InterfaceVpcEndpoint(this, 'CloudWatchLogsEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });

    new ec2.InterfaceVpcEndpoint(this, 'CloudWatchEventsEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_EVENTS,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });

    new ec2.InterfaceVpcEndpoint(this, 'SecretsManagerEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });

    new ec2.InterfaceVpcEndpoint(this, 'KmsEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.KMS,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });

    new ec2.InterfaceVpcEndpoint(this, 'StsEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.STS,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });

    new ec2.InterfaceVpcEndpoint(this, 'SnsEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SNS,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });

    // DynamoDB gateway endpoint — free, no data traverses internet
    new ec2.GatewayVpcEndpoint(this, 'DynamoDbEndpoint', {
      vpc: this.vpc,
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // SSM endpoints for Systems Manager access
    new ec2.InterfaceVpcEndpoint(this, 'SsmEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      securityGroups: [endpointSg],
      privateDnsEnabled: true,
    });

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { KmsStack } from '../../lib/stacks/kms-stack';
import { NetworkingStack } from '../../lib/stacks/networking-stack';

const TEST_ENV = { account: '123456789012', region: 'us-east-1' };

describe('NetworkingStack', () => {
  const app = new cdk.App();
  const kmsStack = new KmsStack(app, 'TestKms', { env: TEST_ENV });
  const stack = new NetworkingStack(app, 'TestNetworking', {
    env: TEST_ENV,
    kmsKey: kmsStack.key,
  });
  const template = Template.fromStack(stack);

  test('creates VPC with no NAT gateways', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  test('creates VPC with no internet gateway', () => {
    template.resourceCountIs('AWS::EC2::InternetGateway', 0);
  });

  test('creates private isolated subnets only', () => {
    // Subnets should not have a route to 0.0.0.0/0 via an IGW
    const routeTables = template.findResources('AWS::EC2::Route');
    const publicRoutes = Object.values(routeTables).filter((r: any) =>
      r.Properties?.GatewayId !== undefined &&
      r.Properties?.DestinationCidrBlock === '0.0.0.0/0',
    );
    expect(publicRoutes).toHaveLength(0);
  });

  test('creates API Gateway VPC endpoint', () => {
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: Match.stringLikeRegexp('execute-api'),
      VpcEndpointType: 'Interface',
      PrivateDnsEnabled: true,
    });
  });

  test('creates DynamoDB gateway endpoint', () => {
    // GatewayVpcEndpoint's service name is a Fn::Join intrinsic — match by type instead
    const gatewayEndpoints = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: { VpcEndpointType: 'Gateway' },
    });
    expect(Object.keys(gatewayEndpoints)).toHaveLength(1);
  });

  test('creates VPC flow logs', () => {
    template.resourceCountIs('AWS::EC2::FlowLog', 1);
  });

  test('creates exactly 10 interface VPC endpoints (1 APIGW + 9 others)', () => {
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: { VpcEndpointType: 'Interface' },
    });
    expect(Object.keys(endpoints)).toHaveLength(10);
  });
});

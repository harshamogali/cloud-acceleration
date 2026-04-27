import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { KmsStack } from '../../lib/stacks/kms-stack';
import { NetworkingStack } from '../../lib/stacks/networking-stack';
import { DataStack } from '../../lib/stacks/data-stack';
import { AuthorizerStack } from '../../lib/stacks/authorizer-stack';
import { ApiHandlerStack } from '../../lib/stacks/api-handler-stack';
import { ApiStack } from '../../lib/stacks/api-stack';

const TEST_ENV = { account: '123456789012', region: 'us-east-1' };
const FAKE_VPCE_ID = 'vpce-0123456789abcdef0';

describe('ApiStack', () => {
  const app = new cdk.App();
  const kmsStack = new KmsStack(app, 'TestKms', { env: TEST_ENV });
  const networking = new NetworkingStack(app, 'TestNetworking', {
    env: TEST_ENV,
    kmsKey: kmsStack.key,
  });
  const data = new DataStack(app, 'TestData', {
    env: TEST_ENV,
    vpc: networking.vpc,
    kmsKey: kmsStack.key,
  });
  const authorizer = new AuthorizerStack(app, 'TestAuthorizer', {
    env: TEST_ENV,
    vpc: networking.vpc,
    kmsKey: kmsStack.key,
  });
  const apiHandler = new ApiHandlerStack(app, 'TestApiHandler', {
    env: TEST_ENV,
    vpc: networking.vpc,
    kmsKey: kmsStack.key,
    table: data.table,
  });
  const stack = new ApiStack(app, 'TestApi', {
    env: TEST_ENV,
    vpc: networking.vpc,
    kmsKey: kmsStack.key,
    vpcEndpointId: FAKE_VPCE_ID,
    authorizerFunction: authorizer.authorizerFunction,
    apiFunction: apiHandler.apiFunction,
  });
  const template = Template.fromStack(stack);

  test('creates a private REST API', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      EndpointConfiguration: {
        Types: ['PRIVATE'],
      },
    });
  });

  test('REST API resource policy denies non-VPCE traffic', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Policy: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: {
              StringNotEquals: { 'aws:sourceVpce': FAKE_VPCE_ID },
            },
          }),
        ]),
      }),
    });
  });

  test('creates a TOKEN authorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'TOKEN',
      Name: 'jwt-authorizer',
      IdentitySource: 'method.request.header.Authorization',
    });
  });

  test('creates /health GET without authorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'NONE',
    });
  });

  test('creates /items GET with CUSTOM authorizer', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'CUSTOM',
    });
  });

  test('enables X-Ray tracing on the stage', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      TracingEnabled: true,
    });
  });

  test('access logs are sent to a CloudWatch log group', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      AccessLogSetting: {
        DestinationArn: Match.anyValue(),
      },
    });
  });
});

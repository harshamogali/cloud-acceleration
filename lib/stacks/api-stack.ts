import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface ApiStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  kmsKey: kms.Key;
  vpcEndpointId: string;
  authorizerFunction: lambda.Function;
  apiFunction: lambda.Function;
  docDbApiFunction?: lambda.Function;
}

export class ApiStack extends cdk.Stack {
  public readonly restApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const accessLogGroup = new logs.LogGroup(this, 'ApiGwAccessLogs', {
      logGroupName: '/cloud-acceleration/apigw-access',
      retention: logs.RetentionDays.ONE_YEAR,
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Private API — only reachable via VPC endpoint (NIST SC-7, AC-17)
    this.restApi = new apigateway.RestApi(this, 'RestApi', {
      restApiName: 'cloud-acceleration-api',
      description: 'NIST-compliant private REST API for Cloud Acceleration platform',
      endpointConfiguration: {
        types: [apigateway.EndpointType.PRIVATE],
        vpcEndpoints: [
          ec2.InterfaceVpcEndpoint.fromInterfaceVpcEndpointAttributes(this, 'ImportedApiGwEndpoint', {
            vpcEndpointId: props.vpcEndpointId,
            port: 443,
          }),
        ],
      },
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            conditions: {
              StringNotEquals: { 'aws:sourceVpce': props.vpcEndpointId },
            },
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
          }),
        ],
      }),
      deployOptions: {
        stageName: 'v1',
        tracingEnabled: true,
        dataTraceEnabled: false,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
        metricsEnabled: true,
        throttlingBurstLimit: 500,
        throttlingRateLimit: 1000,
      },
    });

    // IAM role that API Gateway assumes to invoke the authorizer Lambda.
    // Passing assumeRoleArn prevents CDK's TokenAuthorizer from adding a
    // Lambda resource policy that would reference this stack's API ARN and
    // create a dependency cycle between ApiStack and AuthorizerStack.
    const authorizerInvokeRole = new iam.Role(this, 'AuthorizerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      description: 'Role API Gateway assumes to invoke the Lambda authorizer',
    });
    authorizerInvokeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [props.authorizerFunction.functionArn],
    }));

    // Lambda TOKEN authorizer — validates Bearer JWT (NIST IA-2, AC-3)
    const tokenAuthorizer = new apigateway.TokenAuthorizer(this, 'TokenAuthorizer', {
      handler: props.authorizerFunction,
      authorizerName: 'jwt-authorizer',
      identitySource: 'method.request.header.Authorization',
      resultsCacheTtl: cdk.Duration.minutes(5),
      validationRegex: '^Bearer [-0-9a-zA-Z._]*$',
      assumeRole: authorizerInvokeRole,
    });

    const apiIntegration = new apigateway.LambdaIntegration(props.apiFunction, {
      proxy: true,
      allowTestInvoke: false,
    });

    const methodOptions: apigateway.MethodOptions = {
      authorizer: tokenAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      apiKeyRequired: false,
    };

    // /health — no auth (internal health check endpoint)
    const healthResource = this.restApi.root.addResource('health');
    healthResource.addMethod('GET', apiIntegration, {
      authorizationType: apigateway.AuthorizationType.NONE,
    });

    // /items — protected CRUD resource
    const itemsResource = this.restApi.root.addResource('items');
    itemsResource.addMethod('GET', apiIntegration, methodOptions);
    itemsResource.addMethod('POST', apiIntegration, methodOptions);

    const itemResource = itemsResource.addResource('{id}');
    itemResource.addMethod('GET', apiIntegration, methodOptions);
    itemResource.addMethod('PUT', apiIntegration, methodOptions);
    itemResource.addMethod('DELETE', apiIntegration, methodOptions);

    // /documents — DocumentDB-backed CRUD
    if (props.docDbApiFunction) {
      const docDbIntegration = new apigateway.LambdaIntegration(props.docDbApiFunction, {
        proxy: true,
        allowTestInvoke: false,
      });

      const documentsResource = this.restApi.root.addResource('documents');
      documentsResource.addMethod('GET', docDbIntegration, methodOptions);
      documentsResource.addMethod('POST', docDbIntegration, methodOptions);

      // Internal health probe — no auth (matches /health pattern)
      const documentsHealth = documentsResource.addResource('health');
      documentsHealth.addMethod('GET', docDbIntegration, {
        authorizationType: apigateway.AuthorizationType.NONE,
      });

      const documentResource = documentsResource.addResource('{id}');
      documentResource.addMethod('GET', docDbIntegration, methodOptions);
      documentResource.addMethod('PUT', docDbIntegration, methodOptions);
      documentResource.addMethod('DELETE', docDbIntegration, methodOptions);
    }

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: this.restApi.url });
  }
}

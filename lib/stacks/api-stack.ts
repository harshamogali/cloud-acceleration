import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

interface ApiStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  table: dynamodb.Table;
  kmsKey: kms.Key;
  pagerDutyTopicArn: string;
  vpcEndpointId: string;
}

export class ApiStack extends cdk.Stack {
  public readonly restApi: apigateway.RestApi;
  public readonly apiFunction: lambda.Function;
  public readonly authorizerFunction: lambda.Function;
  public readonly proberFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: props.vpc,
      description: 'Lambda functions — outbound to VPC endpoints only',
      allowAllOutbound: false,
    });
    lambdaSg.addEgressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(443), 'HTTPS to VPC endpoints');

    // Secrets Manager secret for JWT signing key — NIST IA-5
    const jwtSecret = new secretsmanager.Secret(this, 'JwtSigningKey', {
      secretName: '/cloud-acceleration/jwt-signing-key',
      description: 'HMAC-SHA256 signing key for API JWT tokens',
      encryptionKey: props.kmsKey,
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─── Shared Lambda configuration ───────────────────────────────────────────

    const commonEnv = {
      TABLE_NAME: props.table.tableName,
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      NODE_OPTIONS: '--enable-source-maps',
      POWERTOOLS_SERVICE_NAME: 'cloud-acceleration',
      LOG_LEVEL: 'INFO',
    };

    const lambdaDefaults = {
      runtime: lambda.Runtime.NODEJS_22_X,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      tracing: lambda.Tracing.ACTIVE,
      insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_229_0,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(29),
      environmentEncryption: props.kmsKey,
    };

    // ─── Lambda Authorizer ─────────────────────────────────────────────────────

    const authLogGroup = new logs.LogGroup(this, 'AuthorizerLogs', {
      logGroupName: '/cloud-acceleration/authorizer',
      retention: logs.RetentionDays.ONE_YEAR,
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const authRole = new iam.Role(this, 'AuthorizerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Lambda authorizer execution role',
    });
    authRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'));
    authRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [authLogGroup.logGroupArn],
    }));
    authRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [jwtSecret.secretArn],
    }));
    authRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [props.kmsKey.keyArn],
    }));
    authRole.addToPolicy(new iam.PolicyStatement({
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }));
    authRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'CloudAcceleration/Authorizer' } },
    }));

    this.authorizerFunction = new lambda.Function(this, 'AuthorizerFunction', {
      ...lambdaDefaults,
      functionName: 'cloud-acceleration-authorizer',
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/authorizer'),
      role: authRole,
      logGroup: authLogGroup,
      environment: {
        ...commonEnv,
        JWT_SECRET_ARN: jwtSecret.secretArn,
      },
    });

    // ─── API Handler Lambda ────────────────────────────────────────────────────

    const apiLogGroup = new logs.LogGroup(this, 'ApiLogs', {
      logGroupName: '/cloud-acceleration/api',
      retention: logs.RetentionDays.ONE_YEAR,
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const apiRole = new iam.Role(this, 'ApiRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'API handler Lambda execution role',
    });
    apiRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'));
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [apiLogGroup.logGroupArn],
    }));
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
        'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:TransactWriteItems',
      ],
      resources: [props.table.tableArn, `${props.table.tableArn}/index/*`],
    }));
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [props.kmsKey.keyArn],
    }));
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }));
    apiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'CloudAcceleration/Api' } },
    }));

    this.apiFunction = new lambda.Function(this, 'ApiFunction', {
      ...lambdaDefaults,
      functionName: 'cloud-acceleration-api',
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/api'),
      role: apiRole,
      logGroup: apiLogGroup,
      environment: {
        ...commonEnv,
      },
    });

    // ─── Health Prober Lambda ──────────────────────────────────────────────────

    const proberLogGroup = new logs.LogGroup(this, 'ProberLogs', {
      logGroupName: '/cloud-acceleration/prober',
      retention: logs.RetentionDays.ONE_YEAR,
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const proberRole = new iam.Role(this, 'ProberRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Health prober Lambda execution role',
    });
    proberRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'));
    proberRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [proberLogGroup.logGroupArn],
    }));
    proberRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
      resources: [props.table.tableArn],
    }));
    proberRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [props.kmsKey.keyArn],
    }));
    proberRole.addToPolicy(new iam.PolicyStatement({
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }));
    proberRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'CloudAcceleration/Prober' } },
    }));
    proberRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:cloud-acceleration-api`],
    }));

    this.proberFunction = new lambda.Function(this, 'ProberFunction', {
      ...lambdaDefaults,
      functionName: 'cloud-acceleration-prober',
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/prober'),
      role: proberRole,
      logGroup: proberLogGroup,
      timeout: cdk.Duration.minutes(2),
      environment: {
        ...commonEnv,
        API_FUNCTION_NAME: 'cloud-acceleration-api',
      },
    });

    // Schedule prober every minute — NIST SI-6: security function verification
    new events.Rule(this, 'ProberSchedule', {
      ruleName: 'cloud-acceleration-prober',
      description: 'Triggers health prober every minute',
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(this.proberFunction)],
    });

    // ─── Private REST API Gateway ──────────────────────────────────────────────

    const apiAccessLogGroup = new logs.LogGroup(this, 'ApiGwAccessLogs', {
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
          // Only allow access from the VPC endpoint — deny everything else
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            conditions: {
              StringNotEquals: {
                'aws:sourceVpce': props.vpcEndpointId,
              },
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
        dataTraceEnabled: false,       // Do not log request/response bodies (PII risk)
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogGroup),
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
      defaultCorsPreflightOptions: undefined,  // No CORS — private API
    });

    // Lambda TOKEN authorizer — validates Bearer JWT (NIST IA-2, AC-3)
    const tokenAuthorizer = new apigateway.TokenAuthorizer(this, 'TokenAuthorizer', {
      handler: this.authorizerFunction,
      authorizerName: 'jwt-authorizer',
      identitySource: 'method.request.header.Authorization',
      resultsCacheTtl: cdk.Duration.minutes(5),
      validationRegex: '^Bearer [-0-9a-zA-Z._]*$',
    });

    // ─── API Resources ─────────────────────────────────────────────────────────

    const apiIntegration = new apigateway.LambdaIntegration(this.apiFunction, {
      proxy: true,
      allowTestInvoke: false,
    });

    const methodOptions: apigateway.MethodOptions = {
      authorizer: tokenAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
      apiKeyRequired: false,
    };

    // /health — public endpoint for internal load balancer health checks (no auth)
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

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: this.restApi.url });
    new cdk.CfnOutput(this, 'JwtSecretArn', { value: jwtSecret.secretArn });
  }
}

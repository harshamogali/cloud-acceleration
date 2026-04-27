import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface ApiHandlerStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  kmsKey: kms.Key;
  table: dynamodb.Table;
}

export class ApiHandlerStack extends cdk.Stack {
  public readonly apiFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: ApiHandlerStackProps) {
    super(scope, id, props);

    const sg = new ec2.SecurityGroup(this, 'Sg', {
      vpc: props.vpc,
      description: 'API handler Lambda — outbound to VPC endpoints only',
      allowAllOutbound: false,
    });
    sg.addEgressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(443), 'HTTPS to VPC endpoints');

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: '/cloud-acceleration/api',
      retention: logs.RetentionDays.ONE_YEAR,
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'API handler Lambda execution role',
    });
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [logGroup.logGroupArn],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
        'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:TransactWriteItems',
      ],
      resources: [props.table.tableArn, `${props.table.tableArn}/index/*`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [props.kmsKey.keyArn],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'CloudAcceleration/Api' } },
    }));

    this.apiFunction = new lambda.Function(this, 'Function', {
      functionName: 'cloud-acceleration-api',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/api'),
      role,
      logGroup,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [sg],
      tracing: lambda.Tracing.ACTIVE,
      insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_229_0,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(29),
      environmentEncryption: props.kmsKey,
      environment: {
        TABLE_NAME: props.table.tableName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: 'cloud-acceleration',
        LOG_LEVEL: 'INFO',
      },
    });

    new cdk.CfnOutput(this, 'FunctionArn', { value: this.apiFunction.functionArn });
  }
}

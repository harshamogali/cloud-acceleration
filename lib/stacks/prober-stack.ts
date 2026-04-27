import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';

interface ProberStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  kmsKey: kms.Key;
  table: dynamodb.Table;
  apiFunction: lambda.Function;
}

export class ProberStack extends cdk.Stack {
  public readonly proberFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: ProberStackProps) {
    super(scope, id, props);

    const sg = new ec2.SecurityGroup(this, 'Sg', {
      vpc: props.vpc,
      description: 'Prober Lambda — outbound to VPC endpoints only',
      allowAllOutbound: false,
    });
    sg.addEgressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(443), 'HTTPS to VPC endpoints');

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: '/cloud-acceleration/prober',
      retention: logs.RetentionDays.ONE_YEAR,
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Health prober Lambda execution role',
    });
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [logGroup.logGroupArn],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
      resources: [props.table.tableArn],
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
      conditions: { StringEquals: { 'cloudwatch:namespace': 'CloudAcceleration/Prober' } },
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [props.apiFunction.functionArn],
    }));

    this.proberFunction = new lambda.Function(this, 'Function', {
      functionName: 'cloud-acceleration-prober',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/prober'),
      role,
      logGroup,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [sg],
      tracing: lambda.Tracing.ACTIVE,
      insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_229_0,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(2),
      environmentEncryption: props.kmsKey,
      environment: {
        TABLE_NAME: props.table.tableName,
        API_FUNCTION_NAME: props.apiFunction.functionName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: 'cloud-acceleration',
        LOG_LEVEL: 'INFO',
      },
    });

    // Run every minute — NIST SI-6: security function verification
    new events.Rule(this, 'Schedule', {
      ruleName: 'cloud-acceleration-prober',
      description: 'Triggers health prober every minute',
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(this.proberFunction)],
    });

    new cdk.CfnOutput(this, 'FunctionArn', { value: this.proberFunction.functionArn });
  }
}

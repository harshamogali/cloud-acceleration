import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import * as path from 'path';
import { LOG_RETENTION, LAMBDA_RUNTIME, LAMBDA_ARCH, LAMBDA_INSIGHTS } from '../constants';

interface AlertingStackProps extends cdk.StackProps {
  kmsKey: kms.Key;
}

export class AlertingStack extends cdk.Stack {
  public readonly pagerDutyTopic: sns.Topic;
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: AlertingStackProps) {
    super(scope, id, props);

    // PagerDuty integration key stored in Secrets Manager — NIST IA-5
    const pagerDutySecret = new secretsmanager.Secret(this, 'PagerDutySecret', {
      secretName: '/cloud-acceleration/pagerduty-integration-key',
      description: 'PagerDuty Events API v2 integration key',
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // SNS topic for CloudWatch alarm notifications — KMS encrypted
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: 'cloud-acceleration-alarms',
      masterKey: props.kmsKey,
      displayName: 'Cloud Acceleration Alarms',
    });

    // SNS topic that fans out to PagerDuty via Lambda bridge
    this.pagerDutyTopic = new sns.Topic(this, 'PagerDutyTopic', {
      topicName: 'cloud-acceleration-pagerduty',
      masterKey: props.kmsKey,
      displayName: 'Cloud Acceleration PagerDuty',
    });

    const pdLogGroup = new logs.LogGroup(this, 'PagerDutyBridgeLogs', {
      logGroupName: '/cloud-acceleration/pagerduty-bridge',
      retention: LOG_RETENTION,
      encryptionKey: props.kmsKey,
      // DESTROY: see networking-stack.ts for rationale.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Least-privilege execution role — NIST AC-6
    const pdRole = new iam.Role(this, 'PagerDutyBridgeRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    pdRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [pdLogGroup.logGroupArn],
    }));
    pdRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [pagerDutySecret.secretArn],
    }));
    pdRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [props.kmsKey.keyArn],
    }));

    // PagerDuty bridge — forwards SNS alarm notifications to PagerDuty Events API v2.
    // Intentionally NOT placed inside the VPC: it must reach events.pagerduty.com outbound.
    const pdBridgeFunction = new NodejsFunction(this, 'PagerDutyBridge', {
      functionName: 'cloud-acceleration-pagerduty-bridge',
      runtime: LAMBDA_RUNTIME,
      entry: path.join(__dirname, '../../lambda/pagerduty-bridge/index.ts'),
      role: pdRole,
      logGroup: pdLogGroup,
      timeout: cdk.Duration.seconds(30),
      architecture: LAMBDA_ARCH,
      insightsVersion: LAMBDA_INSIGHTS,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        PD_SECRET_ARN: pagerDutySecret.secretArn,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    this.alarmTopic.addSubscription(new subscriptions.LambdaSubscription(pdBridgeFunction));

    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: this.alarmTopic.topicArn });
    new cdk.CfnOutput(this, 'PagerDutyTopicArn', { value: this.pagerDutyTopic.topicArn });
    new cdk.CfnOutput(this, 'PagerDutySecretArn', { value: pagerDutySecret.secretArn });
  }
}

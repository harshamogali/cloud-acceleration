import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

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

    // Log group for PagerDuty bridge Lambda
    const pdLogGroup = new logs.LogGroup(this, 'PagerDutyBridgeLogs', {
      logGroupName: '/cloud-acceleration/pagerduty-bridge',
      retention: logs.RetentionDays.ONE_YEAR,
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Lambda execution role with least privilege — NIST AC-6
    const pdRole = new iam.Role(this, 'PagerDutyBridgeRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for PagerDuty bridge Lambda',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
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

    // PagerDuty bridge Lambda — forwards SNS alarms to PagerDuty Events API v2
    // NOTE: This Lambda runs WITHOUT VPC access to reach PagerDuty's HTTPS endpoint.
    // In a fully air-gapped environment, replace with an outbound proxy or HTTPS VPC endpoint.
    const pdBridgeFunction = new lambda.Function(this, 'PagerDutyBridge', {
      functionName: 'cloud-acceleration-pagerduty-bridge',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const https = require('https');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const sm = new SecretsManagerClient();
let cachedKey;

async function getIntegrationKey() {
  if (cachedKey) return cachedKey;
  const res = await sm.send(new GetSecretValueCommand({
    SecretId: process.env.PD_SECRET_ARN,
  }));
  cachedKey = res.SecretString;
  return cachedKey;
}

exports.handler = async (event) => {
  const integrationKey = await getIntegrationKey();
  for (const record of event.Records) {
    const snsMessage = JSON.parse(record.Sns.Message);
    const payload = {
      routing_key: integrationKey,
      event_action: snsMessage.NewStateValue === 'ALARM' ? 'trigger' : 'resolve',
      dedup_key: snsMessage.AlarmName,
      payload: {
        summary: snsMessage.AlarmDescription || snsMessage.AlarmName,
        severity: 'critical',
        source: snsMessage.AlarmArn,
        custom_details: {
          alarm_name: snsMessage.AlarmName,
          state: snsMessage.NewStateValue,
          reason: snsMessage.NewStateReason,
          region: snsMessage.Region,
          account: snsMessage.AWSAccountId,
        },
      },
    };

    await new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = https.request({
        hostname: 'events.pagerduty.com',
        path: '/v2/enqueue',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
};
      `),
      role: pdRole,
      timeout: cdk.Duration.seconds(30),
      environment: {
        PD_SECRET_ARN: pagerDutySecret.secretArn,
        NODE_OPTIONS: '--enable-source-maps',
      },
      logGroup: pdLogGroup,
      tracing: lambda.Tracing.ACTIVE,
    });

    // Wire the alarm topic → PagerDuty bridge
    this.alarmTopic.addSubscription(new subscriptions.LambdaSubscription(pdBridgeFunction));

    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: this.alarmTopic.topicArn });
    new cdk.CfnOutput(this, 'PagerDutyTopicArn', { value: this.pagerDutyTopic.topicArn });
    new cdk.CfnOutput(this, 'PagerDutySecretArn', { value: pagerDutySecret.secretArn });
  }
}

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
import * as path from 'path';
import { VpcLambdaFunction } from '../constructs/vpc-lambda-function';

interface ProberStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  kmsKey: kms.Key;
  table: dynamodb.Table;
  apiFunction: lambda.Function;
}

export class ProberStack extends cdk.Stack {
  public readonly proberFunction: lambda.Function;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: ProberStackProps) {
    super(scope, id, props);

    const vpcFn = new VpcLambdaFunction(this, 'Prober', {
      vpc: props.vpc,
      kmsKey: props.kmsKey,
      functionName: 'cloud-acceleration-prober',
      entry: path.join(__dirname, '../../lambda/prober/index.ts'),
      logGroupName: '/cloud-acceleration/prober',
      timeout: cdk.Duration.minutes(2),
      extraPolicies: [
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
          resources: [props.table.tableArn],
        }),
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [props.apiFunction.functionArn],
        }),
        new iam.PolicyStatement({
          actions: ['cloudwatch:PutMetricData'],
          resources: ['*'],
          conditions: { StringEquals: { 'cloudwatch:namespace': 'CloudAcceleration/Prober' } },
        }),
      ],
      environment: {
        TABLE_NAME: props.table.tableName,
        API_FUNCTION_NAME: props.apiFunction.functionName,
      },
    });

    this.proberFunction = vpcFn.function;
    this.logGroup = vpcFn.logGroup;

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

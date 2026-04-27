import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';
import { VpcLambdaFunction } from '../constructs/vpc-lambda-function';

interface ApiHandlerStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  kmsKey: kms.Key;
  table: dynamodb.Table;
}

export class ApiHandlerStack extends cdk.Stack {
  public readonly apiFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: ApiHandlerStackProps) {
    super(scope, id, props);

    const vpcFn = new VpcLambdaFunction(this, 'ApiHandler', {
      vpc: props.vpc,
      kmsKey: props.kmsKey,
      functionName: 'cloud-acceleration-api',
      entry: path.join(__dirname, '../../lambda/api/index.ts'),
      logGroupName: '/cloud-acceleration/api',
      extraPolicies: [
        new iam.PolicyStatement({
          actions: [
            'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
            'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:TransactWriteItems',
          ],
          resources: [props.table.tableArn, `${props.table.tableArn}/index/*`],
        }),
        new iam.PolicyStatement({
          actions: ['cloudwatch:PutMetricData'],
          resources: ['*'],
          conditions: { StringEquals: { 'cloudwatch:namespace': 'CloudAcceleration/Api' } },
        }),
      ],
      environment: {
        TABLE_NAME: props.table.tableName,
      },
    });

    this.apiFunction = vpcFn.function;

    new cdk.CfnOutput(this, 'FunctionArn', { value: this.apiFunction.functionArn });
  }
}

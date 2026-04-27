import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';
import { VpcLambdaFunction } from '../constructs/vpc-lambda-function';

interface AuthorizerStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  kmsKey: kms.Key;
}

export class AuthorizerStack extends cdk.Stack {
  public readonly authorizerFunction: lambda.Function;
  public readonly jwtSecret: secretsmanager.Secret;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: AuthorizerStackProps) {
    super(scope, id, props);

    // JWT signing key — NIST IA-5: authenticator management
    this.jwtSecret = new secretsmanager.Secret(this, 'JwtSigningKey', {
      secretName: '/cloud-acceleration/jwt-signing-key',
      description: 'HMAC-SHA256 signing key for API JWT tokens',
      encryptionKey: props.kmsKey,
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const vpcFn = new VpcLambdaFunction(this, 'Authorizer', {
      vpc: props.vpc,
      kmsKey: props.kmsKey,
      functionName: 'cloud-acceleration-authorizer',
      entry: path.join(__dirname, '../../lambda/authorizer/index.ts'),
      logGroupName: '/cloud-acceleration/authorizer',
      extraPolicies: [
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [this.jwtSecret.secretArn],
        }),
        new iam.PolicyStatement({
          actions: ['cloudwatch:PutMetricData'],
          resources: ['*'],
          conditions: { StringEquals: { 'cloudwatch:namespace': 'CloudAcceleration/Authorizer' } },
        }),
      ],
      environment: {
        JWT_SECRET_ARN: this.jwtSecret.secretArn,
      },
    });

    this.authorizerFunction = vpcFn.function;
    this.logGroup = vpcFn.logGroup;

    new cdk.CfnOutput(this, 'FunctionArn', { value: this.authorizerFunction.functionArn });
    new cdk.CfnOutput(this, 'JwtSecretArn', { value: this.jwtSecret.secretArn });
  }
}

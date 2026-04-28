import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, ICommandHooks } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import {
  LOG_RETENTION,
  LAMBDA_RUNTIME,
  LAMBDA_ARCH,
  LAMBDA_INSIGHTS,
  LAMBDA_DEFAULT_MEMORY,
  LAMBDA_DEFAULT_TIMEOUT,
  LAMBDA_COMMON_ENV,
} from '../constants';

export interface VpcLambdaFunctionProps {
  vpc: ec2.Vpc;
  kmsKey: kms.Key;
  functionName: string;
  /** Absolute path to the Lambda entry TypeScript file. */
  entry: string;
  logGroupName: string;
  memorySize?: number;
  timeout?: cdk.Duration;
  environment?: Record<string, string>;
  /** Additional IAM policy statements granted to the execution role. */
  extraPolicies?: iam.PolicyStatement[];
  /** Non-AWS-SDK npm packages to install into the bundle (skips esbuild for these). */
  bundlingNodeModules?: string[];
  /** esbuild command hooks — used to copy non-imported assets (e.g. TLS CA bundles). */
  bundlingCommandHooks?: ICommandHooks;
}

/**
 * VPC-attached Lambda function with standard security baseline:
 * isolated subnet placement, HTTPS-only egress, KMS-encrypted log group,
 * least-privilege IAM role, X-Ray active tracing, Lambda Insights.
 */
export class VpcLambdaFunction extends Construct {
  public readonly function: lambda.Function;
  public readonly logGroup: logs.LogGroup;
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: VpcLambdaFunctionProps) {
    super(scope, id);

    const sg = new ec2.SecurityGroup(this, 'Sg', {
      vpc: props.vpc,
      description: `${props.functionName} — outbound HTTPS to VPC endpoints only`,
      allowAllOutbound: false,
    });
    sg.addEgressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'HTTPS to VPC endpoints',
    );

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: props.logGroupName,
      retention: LOG_RETENTION,
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    this.role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [this.logGroup.logGroupArn],
    }));
    this.role.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [props.kmsKey.keyArn],
    }));
    this.role.addToPolicy(new iam.PolicyStatement({
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }));

    for (const statement of props.extraPolicies ?? []) {
      this.role.addToPolicy(statement);
    }

    this.function = new NodejsFunction(this, 'Function', {
      functionName: props.functionName,
      runtime: LAMBDA_RUNTIME,
      entry: props.entry,
      role: this.role,
      logGroup: this.logGroup,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [sg],
      tracing: lambda.Tracing.ACTIVE,
      insightsVersion: LAMBDA_INSIGHTS,
      architecture: LAMBDA_ARCH,
      memorySize: props.memorySize ?? LAMBDA_DEFAULT_MEMORY,
      timeout: props.timeout ?? LAMBDA_DEFAULT_TIMEOUT,
      environmentEncryption: props.kmsKey,
      environment: { ...LAMBDA_COMMON_ENV, ...props.environment },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
        nodeModules: props.bundlingNodeModules,
        commandHooks: props.bundlingCommandHooks,
      },
    });
  }
}

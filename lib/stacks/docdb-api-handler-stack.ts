import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';
import { VpcLambdaFunction } from '../constructs/vpc-lambda-function';

interface DocDbApiHandlerStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  kmsKey: kms.Key;
  cluster: docdb.DatabaseCluster;
  clusterSecurityGroup: ec2.SecurityGroup;
  credentialsSecret: secretsmanager.ISecret;
}

export class DocDbApiHandlerStack extends cdk.Stack {
  public readonly apiFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: DocDbApiHandlerStackProps) {
    super(scope, id, props);

    const vpcFn = new VpcLambdaFunction(this, 'DocDbApiHandler', {
      vpc: props.vpc,
      kmsKey: props.kmsKey,
      functionName: 'cloud-acceleration-docdb-api',
      entry: path.join(__dirname, '../../lambda/docdb-api/index.ts'),
      logGroupName: '/cloud-acceleration/docdb-api',
      memorySize: 1024,
      timeout: cdk.Duration.seconds(29),
      // Bundle the mongodb driver (esbuild can't tree-shake bson native code reliably).
      bundlingNodeModules: ['mongodb'],
      // Download the AWS-issued CA bundle into the deployment package so the
      // driver can verify the cluster's TLS certificate. The Lambda code reads
      // it from /var/task/global-bundle.pem at runtime.
      bundlingCommandHooks: {
        beforeBundling(_inputDir: string, _outputDir: string): string[] {
          return [];
        },
        afterBundling(_inputDir: string, outputDir: string): string[] {
          return [
            `curl -sSfL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o ${outputDir}/global-bundle.pem`,
          ];
        },
        beforeInstall(_inputDir: string, _outputDir: string): string[] {
          return [];
        },
      },
      extraPolicies: [
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [props.credentialsSecret.secretArn],
        }),
        new iam.PolicyStatement({
          actions: ['cloudwatch:PutMetricData'],
          resources: ['*'],
          conditions: { StringEquals: { 'cloudwatch:namespace': 'CloudAcceleration/DocDb' } },
        }),
      ],
      environment: {
        DOCDB_SECRET_ARN: props.credentialsSecret.secretArn,
        DOCDB_CLUSTER_ENDPOINT: props.cluster.clusterEndpoint.hostname,
        DOCDB_CLUSTER_PORT: cdk.Token.asString(props.cluster.clusterEndpoint.port),
        DOCDB_DATABASE: 'cloud_acceleration',
        DOCDB_COLLECTION: 'documents',
        DOCDB_TLS_CA_FILE: '/var/task/global-bundle.pem',
      },
    });

    this.apiFunction = vpcFn.function;

    // Allow the Lambda's security group to reach the DocumentDB cluster on
    // its TLS port. We import the cluster SG (rather than reference the
    // construct directly) so the SecurityGroupIngress resource is placed in
    // *this* stack — avoiding a cross-stack cycle with DocDbStack.
    const lambdaSg = vpcFn.function.connections.securityGroups[0];
    const importedClusterSg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ImportedClusterSg',
      props.clusterSecurityGroup.securityGroupId,
      { mutable: true, allowAllOutbound: false },
    );
    importedClusterSg.addIngressRule(
      lambdaSg,
      ec2.Port.tcp(props.cluster.clusterEndpoint.port),
      'CRUD Lambda → DocumentDB',
    );
    // The Lambda's egress rule (HTTPS to VPC CIDR) was set by VpcLambdaFunction,
    // but DocumentDB listens on 27017, not 443 — add it explicitly.
    lambdaSg.addEgressRule(
      ec2.Peer.securityGroupId(props.clusterSecurityGroup.securityGroupId),
      ec2.Port.tcp(props.cluster.clusterEndpoint.port),
      'TLS to DocumentDB cluster',
    );

    new cdk.CfnOutput(this, 'FunctionArn', { value: this.apiFunction.functionArn });
  }
}

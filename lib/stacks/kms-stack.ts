import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class KmsStack extends cdk.Stack {
  public readonly key: kms.Key;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // Customer-managed KMS key — single CMK used for encryption across all stacks.
    // Centralised here so key policy, rotation, and lifecycle are managed independently
    // of any consuming stack. NIST SC-12, SC-28.
    this.key = new kms.Key(this, 'PlatformKey', {
      description: 'CMK for Cloud Acceleration platform — NIST SC-28',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: 'RootAccess',
            principals: [new iam.AccountRootPrincipal()],
            actions: ['kms:*'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'CloudWatchLogs',
            principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
            actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
            resources: ['*'],
            conditions: {
              ArnLike: {
                'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:*`,
              },
            },
          }),
          new iam.PolicyStatement({
            sid: 'SNSService',
            principals: [new iam.ServicePrincipal('sns.amazonaws.com')],
            actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
            resources: ['*'],
          }),
        ],
      }),
    });

    new kms.Alias(this, 'PlatformKeyAlias', {
      aliasName: 'alias/cloud-acceleration-platform',
      targetKey: this.key,
    });

    new cdk.CfnOutput(this, 'KeyArn', { value: this.key.keyArn });
    new cdk.CfnOutput(this, 'KeyId', { value: this.key.keyId });
  }
}

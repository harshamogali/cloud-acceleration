import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import { Construct } from 'constructs';

interface DataStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  kmsKey: kms.Key;
}

export class DataStack extends cdk.Stack {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // DynamoDB table with CMK encryption and PITR — NIST SC-28, CP-9
    this.table = new dynamodb.Table(this, 'DataTable', {
      tableName: 'cloud-acceleration-data',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      tableClass: dynamodb.TableClass.STANDARD,
      contributorInsightsSpecification: { enabled: true },
    });

    // GSI for querying by entity type
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi-type-created',
      partitionKey: { name: 'entityType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // AWS Backup vault with KMS encryption — NIST CP-9
    const backupVault = new backup.BackupVault(this, 'BackupVault', {
      backupVaultName: 'cloud-acceleration-vault',
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // Prevent vault deletion even with full permissions (compliance lock)
      accessPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: 'DenyDeleteRecoveryPoint',
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: [
              'backup:DeleteRecoveryPoint',
              'backup:UpdateRecoveryPointLifecycle',
              'backup:PutBackupVaultAccessPolicy',
            ],
            resources: ['*'],
            conditions: {
              StringNotEquals: {
                'aws:PrincipalArn': [
                  `arn:aws:iam::${this.account}:root`,
                ],
              },
            },
          }),
        ],
      }),
    });

    // Backup plan: daily + weekly + monthly — meets financial industry RPO requirements
    const backupPlan = new backup.BackupPlan(this, 'BackupPlan', {
      backupPlanName: 'cloud-acceleration-backup-plan',
      backupVault,
      backupPlanRules: [
        // Daily backup — 35-day retention
        new backup.BackupPlanRule({
          ruleName: 'daily-backup',
          scheduleExpression: events.Schedule.cron({ hour: '2', minute: '0' }),
          deleteAfter: cdk.Duration.days(35),
          completionWindow: cdk.Duration.hours(2),
          startWindow: cdk.Duration.hours(1),
        }),
        // Weekly backup — 90-day retention
        new backup.BackupPlanRule({
          ruleName: 'weekly-backup',
          scheduleExpression: events.Schedule.cron({ weekDay: 'SUN', hour: '3', minute: '0' }),
          deleteAfter: cdk.Duration.days(90),
          completionWindow: cdk.Duration.hours(4),
          startWindow: cdk.Duration.hours(2),
        }),
        // Monthly backup — 7-year retention (financial regulation compliance)
        new backup.BackupPlanRule({
          ruleName: 'monthly-backup',
          scheduleExpression: events.Schedule.cron({ day: '1', hour: '4', minute: '0' }),
          deleteAfter: cdk.Duration.days(2555), // 7 years
          completionWindow: cdk.Duration.hours(8),
          startWindow: cdk.Duration.hours(4),
        }),
      ],
    });

    backupPlan.addSelection('DynamoDbSelection', {
      resources: [backup.BackupResource.fromDynamoDbTable(this.table)],
      allowRestores: true,
    });

    // Resource policy: deny unencrypted transport — NIST SC-8
    this.table.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyNonTLS',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['dynamodb:*'],
      resources: [this.table.tableArn, `${this.table.tableArn}/*`],
      conditions: {
        Bool: { 'aws:SecureTransport': 'false' },
      },
    }));

    new cdk.CfnOutput(this, 'TableName', { value: this.table.tableName });
    new cdk.CfnOutput(this, 'TableArn', { value: this.table.tableArn });
  }
}

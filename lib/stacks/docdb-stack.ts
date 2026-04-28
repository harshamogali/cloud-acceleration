import * as cdk from 'aws-cdk-lib';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { LOG_RETENTION } from '../constants';

interface DocDbStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  kmsKey: kms.Key;
}

/**
 * Amazon DocumentDB cluster — deployed in the same private VPC as the rest of
 * the platform. Hardened defaults: TLS-only, KMS encryption at rest, audit
 * logging, automatic backups, deletion protection, multi-AZ replicas, and
 * CloudWatch DB Insights via Performance Insights.
 *
 * NIST controls satisfied here: SC-7 (private subnet placement), SC-8 (TLS),
 * SC-12/SC-28 (CMK encryption), AU-2/AU-12 (audit logs), CP-9 (backups +
 * AWS Backup vault), AC-3 (least-privilege client SG).
 */
export class DocDbStack extends cdk.Stack {
  public readonly cluster: docdb.DatabaseCluster;
  public readonly clusterSecurityGroup: ec2.SecurityGroup;
  public readonly credentialsSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DocDbStackProps) {
    super(scope, id, props);

    // Cluster security group — only the application Lambda SGs are permitted
    // to reach the DocumentDB port. Egress is closed (the cluster does not
    // initiate outbound traffic).
    this.clusterSecurityGroup = new ec2.SecurityGroup(this, 'ClusterSg', {
      vpc: props.vpc,
      description: 'DocumentDB cluster - ingress on 27017 from app Lambdas only',
      allowAllOutbound: false,
    });

    // Cluster parameter group — enforce TLS in transit and enable audit logs.
    // NIST SC-8 (TLS), AU-2 (auditable events).
    const parameterGroup = new docdb.ClusterParameterGroup(this, 'ClusterParams', {
      family: 'docdb5.0',
      description: 'TLS-only, audit logs enabled',
      parameters: {
        tls: 'enabled',
        audit_logs: 'enabled',
        ttl_monitor: 'enabled',
        profiler: 'enabled',
        profiler_threshold_ms: '500',
      },
    });

    // DocumentDB cluster.
    // - 3 instances spread across 3 AZs (1 writer + 2 readers)
    // - Storage encrypted with the platform CMK (SC-28)
    // - Backups retained 35 days, daily snapshot window 02:00-03:00 UTC
    // - Audit + profiler logs exported to CloudWatch (AU-12)
    // - Deletion protection on; final snapshot taken on stack delete
    //
    // Master credentials: the cluster's `masterUser.password` is intentionally
    // omitted so CDK auto-generates a random password and stores it in
    // Secrets Manager (encrypted with the platform CMK). The password value
    // never appears in source, the synthesized template, or CFN parameters --
    // only token references resolve to it at deploy time. NIST IA-5.
    this.cluster = new docdb.DatabaseCluster(this, 'Cluster', {
      dbClusterName: 'cloud-acceleration-docdb',
      masterUser: {
        username: 'docdbadmin',
        excludeCharacters: '"@/\\\'',
      },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.LARGE),
      instances: 3,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroup: this.clusterSecurityGroup,
      parameterGroup,
      storageEncrypted: true,
      kmsKey: props.kmsKey,
      backup: {
        retention: cdk.Duration.days(35),
        preferredWindow: '02:00-03:00',
      },
      preferredMaintenanceWindow: 'sun:04:00-sun:05:00',
      deletionProtection: true,
      exportProfilerLogsToCloudWatch: true,
      exportAuditLogsToCloudWatch: true,
      cloudWatchLogsRetention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      copyTagsToSnapshot: true,
    });

    // Capture the auto-generated secret as the public credentials handle.
    // `cluster.secret` is populated by CDK because we omitted masterUser.password.
    if (!this.cluster.secret) {
      throw new Error('Expected cluster.secret to be auto-generated');
    }
    this.credentialsSecret = this.cluster.secret;

    // Automatic rotation every 30 days - NIST IA-5 (authenticator management).
    // Deploys the AWS-published Mongo single-user rotation Lambda (SAR app)
    // into the cluster's VPC. The cluster's SG ingress is wired automatically.
    this.cluster.addRotationSingleUser(cdk.Duration.days(30));

    // Enable Performance Insights / DB Insights on every instance - NIST AU-12.
    // The L2 construct does not surface this flag; toggle it on the underlying
    // CfnDBInstance children. AWS::DocDB::DBInstance does not (yet) accept
    // PerformanceInsightsKMSKeyId or PerformanceInsightsRetentionPeriod via
    // CloudFormation -- it strict-validates and rejects them. So Performance
    // Insights uses the default AWS-managed KMS key and 7-day retention.
    // To use the platform CMK and longer retention, run modify-db-instance
    // post-deploy or via a custom resource.
    for (const node of this.cluster.node.findAll()) {
      if (node instanceof docdb.CfnDBInstance) {
        node.enablePerformanceInsights = true;
      }
    }

    // CloudWatch log groups for audit/profiler are created automatically by
    // the L2 construct, but we proactively create one for slow-query metric
    // filters in observability. Use a fixed name so observability can import.
    new logs.LogGroup(this, 'OpsLogGroup', {
      logGroupName: '/aws/docdb/cloud-acceleration-docdb/ops',
      retention: LOG_RETENTION,
      encryptionKey: props.kmsKey,
      // DESTROY: see networking-stack.ts for rationale.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // AWS Backup vault — provides immutable, cross-account-portable backups
    // independent of DocumentDB native snapshots. NIST CP-9.
    const backupVault = new backup.BackupVault(this, 'BackupVault', {
      backupVaultName: 'cloud-acceleration-docdb-vault',
      encryptionKey: props.kmsKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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
                'aws:PrincipalArn': [`arn:aws:iam::${this.account}:root`],
              },
            },
          }),
        ],
      }),
    });

    const backupPlan = new backup.BackupPlan(this, 'BackupPlan', {
      backupPlanName: 'cloud-acceleration-docdb-backup-plan',
      backupVault,
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: 'daily-backup',
          scheduleExpression: events.Schedule.cron({ hour: '2', minute: '30' }),
          deleteAfter: cdk.Duration.days(35),
          completionWindow: cdk.Duration.hours(2),
          startWindow: cdk.Duration.hours(1),
        }),
        new backup.BackupPlanRule({
          ruleName: 'weekly-backup',
          scheduleExpression: events.Schedule.cron({ weekDay: 'SUN', hour: '3', minute: '30' }),
          deleteAfter: cdk.Duration.days(90),
          completionWindow: cdk.Duration.hours(4),
          startWindow: cdk.Duration.hours(2),
        }),
        new backup.BackupPlanRule({
          ruleName: 'monthly-backup',
          scheduleExpression: events.Schedule.cron({ day: '1', hour: '4', minute: '30' }),
          deleteAfter: cdk.Duration.days(2555), // 7 years — financial retention
          completionWindow: cdk.Duration.hours(8),
          startWindow: cdk.Duration.hours(4),
        }),
      ],
    });

    backupPlan.addSelection('DocDbSelection', {
      resources: [
        backup.BackupResource.fromArn(
          cdk.Stack.of(this).formatArn({
            service: 'rds',
            resource: 'cluster',
            resourceName: this.cluster.clusterIdentifier,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ),
      ],
      allowRestores: true,
    });

    new cdk.CfnOutput(this, 'ClusterEndpoint', { value: this.cluster.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, 'ClusterReadEndpoint', { value: this.cluster.clusterReadEndpoint.hostname });
    new cdk.CfnOutput(this, 'ClusterPort', { value: cdk.Token.asString(this.cluster.clusterEndpoint.port) });
    new cdk.CfnOutput(this, 'CredentialsSecretArn', { value: this.credentialsSecret.secretArn });
  }
}

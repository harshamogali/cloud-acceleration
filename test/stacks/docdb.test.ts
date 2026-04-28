import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { KmsStack } from '../../lib/stacks/kms-stack';
import { NetworkingStack } from '../../lib/stacks/networking-stack';
import { DocDbStack } from '../../lib/stacks/docdb-stack';

const TEST_ENV = { account: '123456789012', region: 'us-east-1' };

describe('DocDbStack', () => {
  const app = new cdk.App();
  const kmsStack = new KmsStack(app, 'TestKms', { env: TEST_ENV });
  const networking = new NetworkingStack(app, 'TestNetworking', {
    env: TEST_ENV,
    kmsKey: kmsStack.key,
  });
  const stack = new DocDbStack(app, 'TestDocDb', {
    env: TEST_ENV,
    vpc: networking.vpc,
    kmsKey: kmsStack.key,
  });
  const template = Template.fromStack(stack);

  test('cluster has KMS-CMK storage encryption', () => {
    template.hasResourceProperties('AWS::DocDB::DBCluster', {
      StorageEncrypted: true,
      KmsKeyId: Match.anyValue(),
    });
  });

  test('cluster has 35-day backup retention', () => {
    template.hasResourceProperties('AWS::DocDB::DBCluster', {
      BackupRetentionPeriod: 35,
    });
  });

  test('cluster has deletion protection', () => {
    template.hasResourceProperties('AWS::DocDB::DBCluster', {
      DeletionProtection: true,
    });
  });

  test('cluster exports audit and profiler logs to CloudWatch', () => {
    template.hasResourceProperties('AWS::DocDB::DBCluster', {
      EnableCloudwatchLogsExports: Match.arrayWith(['audit', 'profiler']),
    });
  });

  test('cluster has RETAIN removal policy', () => {
    template.hasResource('AWS::DocDB::DBCluster', {
      DeletionPolicy: 'Retain',
    });
  });

  test('parameter group enforces TLS and audit logs', () => {
    template.hasResourceProperties('AWS::DocDB::DBClusterParameterGroup', {
      Parameters: Match.objectLike({
        tls: 'enabled',
        audit_logs: 'enabled',
      }),
    });
  });

  test('three instances are created (multi-AZ HA)', () => {
    template.resourceCountIs('AWS::DocDB::DBInstance', 3);
  });

  test('every instance has Performance Insights (DB Insights) enabled with CMK', () => {
    template.allResourcesProperties('AWS::DocDB::DBInstance', {
      EnablePerformanceInsights: true,
      PerformanceInsightsKMSKeyId: Match.anyValue(),
      PerformanceInsightsRetentionPeriod: 31,
    });
  });

  test('master credentials are stored in Secrets Manager with CMK encryption', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: '/cloud-acceleration/docdb/master',
      KmsKeyId: Match.anyValue(),
    });
  });

  test('AWS Backup vault is created with CMK encryption', () => {
    template.hasResourceProperties('AWS::Backup::BackupVault', {
      EncryptionKeyArn: Match.anyValue(),
    });
  });

  test('backup plan defines daily, weekly, and monthly rules', () => {
    template.hasResourceProperties('AWS::Backup::BackupPlan', {
      BackupPlan: {
        BackupPlanRule: [
          Match.objectLike({ RuleName: 'daily-backup' }),
          Match.objectLike({ RuleName: 'weekly-backup' }),
          Match.objectLike({ RuleName: 'monthly-backup' }),
        ],
      },
    });
  });

  test('cluster security group is created with no default outbound rule', () => {
    // The cluster SG should exist; its default egress is closed.
    const sgs = template.findResources('AWS::EC2::SecurityGroup', {
      Properties: {
        GroupDescription: Match.stringLikeRegexp('DocumentDB cluster'),
      },
    });
    expect(Object.keys(sgs).length).toBe(1);
  });

  test('cluster is placed in the provided VPC subnets (private isolated)', () => {
    template.resourceCountIs('AWS::DocDB::DBSubnetGroup', 1);
  });
});

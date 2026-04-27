import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { KmsStack } from '../../lib/stacks/kms-stack';
import { NetworkingStack } from '../../lib/stacks/networking-stack';
import { DataStack } from '../../lib/stacks/data-stack';

const TEST_ENV = { account: '123456789012', region: 'us-east-1' };

describe('DataStack', () => {
  const app = new cdk.App();
  const kmsStack = new KmsStack(app, 'TestKms', { env: TEST_ENV });
  const networking = new NetworkingStack(app, 'TestNetworking', {
    env: TEST_ENV,
    kmsKey: kmsStack.key,
  });
  const stack = new DataStack(app, 'TestData', {
    env: TEST_ENV,
    vpc: networking.vpc,
    kmsKey: kmsStack.key,
  });
  const template = Template.fromStack(stack);

  test('DynamoDB table has PITR enabled', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  test('DynamoDB table has TTL attribute configured', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });

  test('DynamoDB table uses customer-managed KMS key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
    });
  });

  test('DynamoDB table has RETAIN removal policy', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
    });
  });

  test('creates AWS Backup vault', () => {
    template.resourceCountIs('AWS::Backup::BackupVault', 1);
  });

  test('creates backup plan with 3 rules (daily, weekly, monthly)', () => {
    template.hasResourceProperties('AWS::Backup::BackupPlan', {
      BackupPlan: {
        BackupPlanRule: [
          { RuleName: 'daily-backup' },
          { RuleName: 'weekly-backup' },
          { RuleName: 'monthly-backup' },
        ],
      },
    });
  });

  test('creates GSI for entity type queries', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: [
        { IndexName: 'gsi-type-created' },
      ],
    });
  });
});

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { KmsStack } from '../../lib/stacks/kms-stack';

const TEST_ENV = { account: '123456789012', region: 'us-east-1' };

describe('KmsStack', () => {
  const app = new cdk.App();
  const stack = new KmsStack(app, 'TestKms', { env: TEST_ENV });
  const template = Template.fromStack(stack);

  test('creates CMK with key rotation enabled', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  test('creates platform key alias', () => {
    template.hasResourceProperties('AWS::KMS::Alias', {
      AliasName: 'alias/cloud-acceleration-platform',
    });
  });

  test('key has RETAIN removal policy', () => {
    template.hasResource('AWS::KMS::Key', {
      DeletionPolicy: 'Retain',
    });
  });

  test('key policy grants CloudWatch Logs encrypt permissions', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: {
        Statement: [
          { Sid: 'RootAccess' },
          { Sid: 'CloudWatchLogs' },
          { Sid: 'SNSService' },
        ],
      },
    });
  });
});

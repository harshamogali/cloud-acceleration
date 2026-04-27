// Top-level smoke test — verifies the CDK app synthesises without errors.
// Detailed stack assertions live in test/stacks/*.test.ts
import * as cdk from 'aws-cdk-lib';
import { KmsStack } from '../lib/stacks/kms-stack';
import { Template } from 'aws-cdk-lib/assertions';

test('KmsStack synthesises', () => {
  const app = new cdk.App();
  const stack = new KmsStack(app, 'SmokeKms', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::KMS::Key', 1);
});

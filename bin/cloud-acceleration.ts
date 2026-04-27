#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkingStack } from '../lib/stacks/networking-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { ObservabilityStack } from '../lib/stacks/observability-stack';
import { AlertingStack } from '../lib/stacks/alerting-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const tags = {
  Environment: app.node.tryGetContext('environment') ?? 'production',
  Compliance: 'NIST-800-53',
  DataClassification: 'Restricted',
  Owner: 'platform-engineering',
};

const networking = new NetworkingStack(app, 'CloudAccelNetworking', { env, tags });

const data = new DataStack(app, 'CloudAccelData', {
  env,
  tags,
  vpc: networking.vpc,
  kmsKey: networking.kmsKey,
});

const alerting = new AlertingStack(app, 'CloudAccelAlerting', {
  env,
  tags,
  kmsKey: networking.kmsKey,
});

const api = new ApiStack(app, 'CloudAccelApi', {
  env,
  tags,
  vpc: networking.vpc,
  table: data.table,
  kmsKey: networking.kmsKey,
  pagerDutyTopicArn: alerting.pagerDutyTopic.topicArn,
  vpcEndpointId: networking.apiGwVpcEndpoint.vpcEndpointId,
});

new ObservabilityStack(app, 'CloudAccelObservability', {
  env,
  tags,
  vpc: networking.vpc,
  kmsKey: networking.kmsKey,
  table: data.table,
  apiFunction: api.apiFunction,
  authorizerFunction: api.authorizerFunction,
  proberFunction: api.proberFunction,
  alarmTopic: alerting.alarmTopic,
  restApi: api.restApi,
});

app.synth();

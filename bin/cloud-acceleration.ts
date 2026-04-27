#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { KmsStack } from '../lib/stacks/kms-stack';
import { NetworkingStack } from '../lib/stacks/networking-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { AuthorizerStack } from '../lib/stacks/authorizer-stack';
import { ApiHandlerStack } from '../lib/stacks/api-handler-stack';
import { ProberStack } from '../lib/stacks/prober-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { AlertingStack } from '../lib/stacks/alerting-stack';
import { PrivateLinkStack } from '../lib/stacks/privatelink-stack';
import { ObservabilityStack } from '../lib/stacks/observability-stack';

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

const kms = new KmsStack(app, 'CloudAccelKms', { env, tags });

const networking = new NetworkingStack(app, 'CloudAccelNetworking', {
  env, tags, kmsKey: kms.key,
});

const data = new DataStack(app, 'CloudAccelData', {
  env, tags, vpc: networking.vpc, kmsKey: kms.key,
});

const alerting = new AlertingStack(app, 'CloudAccelAlerting', {
  env, tags, kmsKey: kms.key,
});

const authorizer = new AuthorizerStack(app, 'CloudAccelAuthorizer', {
  env, tags, vpc: networking.vpc, kmsKey: kms.key,
});

const apiHandler = new ApiHandlerStack(app, 'CloudAccelApiHandler', {
  env, tags, vpc: networking.vpc, kmsKey: kms.key, table: data.table,
});

const prober = new ProberStack(app, 'CloudAccelProber', {
  env, tags, vpc: networking.vpc, kmsKey: kms.key, table: data.table,
  apiFunction: apiHandler.apiFunction,
});

const api = new ApiStack(app, 'CloudAccelApi', {
  env, tags, vpc: networking.vpc, kmsKey: kms.key,
  vpcEndpointId: networking.apiGwVpcEndpoint.vpcEndpointId,
  authorizerFunction: authorizer.authorizerFunction,
  apiFunction: apiHandler.apiFunction,
});

const privateLink = new PrivateLinkStack(app, 'CloudAccelPrivateLink', {
  env, tags, vpc: networking.vpc, kmsKey: kms.key,
  apiGwVpcEndpoint: networking.apiGwVpcEndpoint,
  // allowedConsumerPrincipals: [new iam.ArnPrincipal('arn:aws:iam::CONSUMER_ACCOUNT_ID:root')],
});

new ObservabilityStack(app, 'CloudAccelObservability', {
  env, tags, vpc: networking.vpc, kmsKey: kms.key,
  table: data.table,
  apiFunction: apiHandler.apiFunction,
  authorizerFunction: authorizer.authorizerFunction,
  proberFunction: prober.proberFunction,
  alarmTopic: alerting.alarmTopic,
  restApi: api.restApi,
  privateLinkStack: privateLink,
});

app.synth();

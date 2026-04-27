import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';

export const LOG_RETENTION = logs.RetentionDays.ONE_YEAR;

export const LAMBDA_RUNTIME = lambda.Runtime.NODEJS_22_X;
export const LAMBDA_ARCH = lambda.Architecture.ARM_64;
export const LAMBDA_INSIGHTS = lambda.LambdaInsightsVersion.VERSION_1_0_229_0;
export const LAMBDA_DEFAULT_MEMORY = 512;
export const LAMBDA_DEFAULT_TIMEOUT = cdk.Duration.seconds(29);

export const LAMBDA_COMMON_ENV: Record<string, string> = {
  AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
  NODE_OPTIONS: '--enable-source-maps',
  POWERTOOLS_SERVICE_NAME: 'cloud-acceleration',
  LOG_LEVEL: 'INFO',
};

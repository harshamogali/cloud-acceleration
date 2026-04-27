import {
  APIGatewayTokenAuthorizerEvent,
  APIGatewayAuthorizerResult,
  Context,
} from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import * as crypto from 'crypto';

const sm = new SecretsManagerClient({});
const cw = new CloudWatchClient({});

let cachedSecret: string | undefined;

async function getSigningKey(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET_ARN! }));
  cachedSecret = res.SecretString!;
  return cachedSecret;
}

function base64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

interface JwtPayload {
  sub: string;
  scope: string[];
  exp: number;
  iat: number;
  jti: string;
}

async function verifyJwt(token: string, secret: string): Promise<JwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT structure');

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64urlDecode(headerB64).toString());

  if (header.alg !== 'HS256') throw new Error(`Unsupported algorithm: ${header.alg}`);

  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(signatureB64))) {
    throw new Error('Invalid signature');
  }

  const payload: JwtPayload = JSON.parse(base64urlDecode(payloadB64).toString());

  if (Date.now() / 1000 > payload.exp) throw new Error('Token expired');
  if (!payload.sub) throw new Error('Missing subject claim');

  return payload;
}

function buildPolicy(
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string,
  context?: Record<string, string>,
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }],
    },
    context,
  };
}

async function emitMetric(metricName: string, value: number): Promise<void> {
  await cw.send(new PutMetricDataCommand({
    Namespace: 'CloudAcceleration/Authorizer',
    MetricData: [{
      MetricName: metricName,
      Value: value,
      Unit: 'Count',
      Dimensions: [{ Name: 'Service', Value: 'cloud-acceleration' }],
    }],
  }));
}

export const handler = async (
  event: APIGatewayTokenAuthorizerEvent,
  _context: Context,
): Promise<APIGatewayAuthorizerResult> => {
  const token = event.authorizationToken?.replace(/^Bearer\s+/i, '');

  if (!token) {
    console.warn(JSON.stringify({ level: 'WARN', message: 'UNAUTHORIZED: missing token', methodArn: event.methodArn }));
    await emitMetric('AuthFailures', 1).catch(() => {});
    return buildPolicy('anonymous', 'Deny', event.methodArn);
  }

  try {
    const secret = await getSigningKey();
    const payload = await verifyJwt(token, secret);

    console.info(JSON.stringify({
      level: 'INFO',
      message: 'AUTH_SUCCESS',
      sub: payload.sub,
      jti: payload.jti,
    }));

    await emitMetric('AuthSuccess', 1).catch(() => {});

    return buildPolicy(payload.sub, 'Allow', event.methodArn, {
      sub: payload.sub,
      scope: payload.scope.join(' '),
      jti: payload.jti,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.warn(JSON.stringify({
      level: 'WARN',
      message: `UNAUTHORIZED: ${msg}`,
      methodArn: event.methodArn,
    }));
    await emitMetric('AuthFailures', 1).catch(() => {});
    return buildPolicy('anonymous', 'Deny', event.methodArn);
  }
};

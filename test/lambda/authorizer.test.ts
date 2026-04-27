import * as crypto from 'crypto';

// Stub AWS SDK before importing the handler
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  GetSecretValueCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  PutMetricDataCommand: jest.fn(),
}));

const TEST_SECRET = 'test-signing-secret-64-chars-long-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeJwt(payload: object, secret: string, overrideHeader?: object): string {
  const header = overrideHeader ?? { alg: 'HS256', typ: 'JWT' };
  const enc = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const headerB64 = enc(header);
  const payloadB64 = enc(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64url');
  return `${headerB64}.${payloadB64}.${sig}`;
}

function makeEvent(token: string, methodArn = 'arn:aws:execute-api:us-east-1:123:abc/v1/GET/items') {
  return { authorizationToken: `Bearer ${token}`, methodArn, type: 'TOKEN' };
}

describe('Lambda authorizer', () => {
  let handler: typeof import('../../lambda/authorizer/index').handler;
  let smSendMock: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();

    // Re-stub after resetModules
    jest.mock('@aws-sdk/client-secrets-manager', () => ({
      SecretsManagerClient: jest.fn().mockImplementation(() => ({
        send: smSendMock,
      })),
      GetSecretValueCommand: jest.fn(),
    }));
    jest.mock('@aws-sdk/client-cloudwatch', () => ({
      CloudWatchClient: jest.fn().mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({}),
      })),
      PutMetricDataCommand: jest.fn(),
    }));

    smSendMock = jest.fn().mockResolvedValue({ SecretString: TEST_SECRET });
    process.env.JWT_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:test';

    handler = require('../../lambda/authorizer/index').handler;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('allows a valid JWT', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt({ sub: 'user-1', scope: ['read'], exp: now + 300, iat: now, jti: 'abc' }, TEST_SECRET);
    const result = await handler(makeEvent(token) as any, {} as any);
    expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
    expect(result.principalId).toBe('user-1');
  });

  test('denies an expired JWT', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt({ sub: 'user-1', scope: ['read'], exp: now - 1, iat: now - 400, jti: 'abc' }, TEST_SECRET);
    const result = await handler(makeEvent(token) as any, {} as any);
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('denies a JWT with wrong signature', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt({ sub: 'user-1', scope: ['read'], exp: now + 300, iat: now, jti: 'abc' }, 'wrong-secret');
    const result = await handler(makeEvent(token) as any, {} as any);
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('denies a JWT with unsupported algorithm', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt(
      { sub: 'user-1', scope: ['read'], exp: now + 300, iat: now, jti: 'abc' },
      TEST_SECRET,
      { alg: 'RS256', typ: 'JWT' },
    );
    const result = await handler(makeEvent(token) as any, {} as any);
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('denies when no token is present', async () => {
    const result = await handler({ authorizationToken: '', methodArn: 'arn:test', type: 'TOKEN' } as any, {} as any);
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('caches the signing key and only calls Secrets Manager once per TTL', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt({ sub: 'u', scope: [], exp: now + 300, iat: now, jti: 'j' }, TEST_SECRET);
    await handler(makeEvent(token) as any, {} as any);
    await handler(makeEvent(token) as any, {} as any);
    expect(smSendMock).toHaveBeenCalledTimes(1);
  });

  test('refreshes the cache after TTL expires', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt({ sub: 'u', scope: [], exp: now + 600, iat: now, jti: 'j' }, TEST_SECRET);
    await handler(makeEvent(token) as any, {} as any);
    // Advance past 5-minute TTL
    jest.advanceTimersByTime(6 * 60 * 1000);
    await handler(makeEvent(token) as any, {} as any);
    expect(smSendMock).toHaveBeenCalledTimes(2);
  });
});

// Stub external clients before requiring the handler
const collectionMock = {
  find: jest.fn(),
  findOne: jest.fn(),
  insertOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  deleteOne: jest.fn(),
  estimatedDocumentCount: jest.fn(),
};
const dbMock = { collection: jest.fn(() => collectionMock) };
const clientMock = { connect: jest.fn().mockResolvedValue(undefined), db: jest.fn(() => dbMock) };

class FakeObjectId {
  private value: string;
  constructor(v?: string) { this.value = v ?? '507f1f77bcf86cd799439011'; }
  toString(): string { return this.value; }
  static isValid(v: string): boolean { return /^[a-fA-F0-9]{24}$/.test(v); }
}

jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => clientMock),
  ObjectId: FakeObjectId,
}));
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({
      SecretString: JSON.stringify({ username: 'docdbadmin', password: 'pw' }),
    }),
  })),
  GetSecretValueCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  PutMetricDataCommand: jest.fn(),
}));

function makeEvent(method: string, resource: string, overrides: Record<string, unknown> = {}) {
  return {
    httpMethod: method,
    resource,
    pathParameters: null,
    queryStringParameters: null,
    body: null,
    requestContext: {
      requestId: 'test-req-id',
      authorizer: { sub: 'test-user' },
    },
    ...overrides,
  };
}

describe('DocDB API Lambda handler', () => {
  let handler: typeof import('../../lambda/docdb-api/index').handler;
  const VALID_ID = '507f1f77bcf86cd799439011';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DOCDB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:test';
    process.env.DOCDB_CLUSTER_ENDPOINT = 'cluster.example.com';
    process.env.DOCDB_CLUSTER_PORT = '27017';
    process.env.DOCDB_DATABASE = 'test_db';
    process.env.DOCDB_COLLECTION = 'documents';
    jest.isolateModules(() => {
      handler = require('../../lambda/docdb-api/index').handler;
    });
  });

  test('GET /documents/health returns 200', async () => {
    collectionMock.estimatedDocumentCount.mockResolvedValueOnce(0);
    const result = await handler(makeEvent('GET', '/documents/health') as any, {} as any);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).status).toBe('healthy');
  });

  test('GET /documents lists items scoped to principal', async () => {
    const cursor = { sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), toArray: jest.fn().mockResolvedValueOnce([{ _id: new FakeObjectId(VALID_ID), name: 'foo', ownerId: 'test-user' }]) };
    collectionMock.find.mockReturnValueOnce(cursor);
    const result = await handler(makeEvent('GET', '/documents') as any, {} as any);
    expect(result.statusCode).toBe(200);
    expect(collectionMock.find).toHaveBeenCalledWith({ ownerId: 'test-user' });
    const body = JSON.parse(result.body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(VALID_ID);
  });

  test('GET /documents/{id} returns 404 when not found', async () => {
    collectionMock.findOne.mockResolvedValueOnce(null);
    const result = await handler(
      makeEvent('GET', '/documents/{id}', { pathParameters: { id: VALID_ID } }) as any,
      {} as any,
    );
    expect(result.statusCode).toBe(404);
  });

  test('GET /documents/{id} returns 400 for malformed id', async () => {
    const result = await handler(
      makeEvent('GET', '/documents/{id}', { pathParameters: { id: 'not-an-objectid' } }) as any,
      {} as any,
    );
    expect(result.statusCode).toBe(400);
  });

  test('POST /documents returns 400 for missing body', async () => {
    const result = await handler(makeEvent('POST', '/documents') as any, {} as any);
    expect(result.statusCode).toBe(400);
  });

  test('POST /documents returns 400 for invalid JSON', async () => {
    const result = await handler(
      makeEvent('POST', '/documents', { body: 'not-json' }) as any,
      {} as any,
    );
    expect(result.statusCode).toBe(400);
  });

  test('POST /documents creates with server-controlled identity', async () => {
    collectionMock.insertOne.mockResolvedValueOnce({ insertedId: new FakeObjectId(VALID_ID) });
    const result = await handler(
      makeEvent('POST', '/documents', { body: JSON.stringify({ name: 'foo', id: 'attempted-override' }) }) as any,
      {} as any,
    );
    expect(result.statusCode).toBe(201);
    const inserted = collectionMock.insertOne.mock.calls[0][0];
    expect(inserted.id).toBeUndefined();
    expect(inserted._id).toBeUndefined();
    expect(inserted.ownerId).toBe('test-user');
    expect(inserted.createdBy).toBe('test-user');
  });

  test('PUT /documents/{id} strips identity/ownership fields', async () => {
    collectionMock.findOneAndUpdate.mockResolvedValueOnce({ _id: new FakeObjectId(VALID_ID), name: 'updated', ownerId: 'test-user' });
    const result = await handler(
      makeEvent('PUT', '/documents/{id}', {
        pathParameters: { id: VALID_ID },
        body: JSON.stringify({ name: 'updated', ownerId: 'attacker', _id: 'malicious' }),
      }) as any,
      {} as any,
    );
    expect(result.statusCode).toBe(200);
    const setOp = collectionMock.findOneAndUpdate.mock.calls[0][1].$set;
    expect(setOp.ownerId).toBeUndefined();
    expect(setOp._id).toBeUndefined();
    expect(setOp.name).toBe('updated');
  });

  test('PUT /documents/{id} returns 404 when not found', async () => {
    collectionMock.findOneAndUpdate.mockResolvedValueOnce(null);
    const result = await handler(
      makeEvent('PUT', '/documents/{id}', {
        pathParameters: { id: VALID_ID },
        body: JSON.stringify({ name: 'updated' }),
      }) as any,
      {} as any,
    );
    expect(result.statusCode).toBe(404);
  });

  test('DELETE /documents/{id} returns 204 when deleted', async () => {
    collectionMock.deleteOne.mockResolvedValueOnce({ deletedCount: 1 });
    const result = await handler(
      makeEvent('DELETE', '/documents/{id}', { pathParameters: { id: VALID_ID } }) as any,
      {} as any,
    );
    expect(result.statusCode).toBe(204);
  });

  test('DELETE /documents/{id} returns 404 when nothing was deleted', async () => {
    collectionMock.deleteOne.mockResolvedValueOnce({ deletedCount: 0 });
    const result = await handler(
      makeEvent('DELETE', '/documents/{id}', { pathParameters: { id: VALID_ID } }) as any,
      {} as any,
    );
    expect(result.statusCode).toBe(404);
  });

  test('unknown route returns 404', async () => {
    const result = await handler(makeEvent('GET', '/unknown') as any, {} as any);
    expect(result.statusCode).toBe(404);
  });

  test('response includes security headers', async () => {
    collectionMock.estimatedDocumentCount.mockResolvedValueOnce(0);
    const result = await handler(makeEvent('GET', '/documents/health') as any, {} as any);
    expect(result.headers!['Strict-Transport-Security']).toContain('max-age=');
    expect(result.headers!['X-Frame-Options']).toBe('DENY');
    expect(result.headers!['Cache-Control']).toBe('no-store');
  });
});

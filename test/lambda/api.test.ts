// Stub AWS SDK before importing the handler
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  GetItemCommand: jest.fn(),
  PutItemCommand: jest.fn(),
  DeleteItemCommand: jest.fn(),
  QueryCommand: jest.fn(),
  UpdateItemCommand: jest.fn(),
}));
jest.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: jest.fn((obj) => obj),
  unmarshall: jest.fn((obj) => obj),
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

describe('API Lambda handler', () => {
  let handler: typeof import('../../lambda/api/index').handler;
  let ddbSendMock: jest.Mock;

  beforeEach(() => {
    jest.resetModules();

    ddbSendMock = jest.fn();
    jest.mock('@aws-sdk/client-dynamodb', () => ({
      DynamoDBClient: jest.fn().mockImplementation(() => ({ send: ddbSendMock })),
      GetItemCommand: jest.fn(),
      PutItemCommand: jest.fn(),
      DeleteItemCommand: jest.fn(),
      QueryCommand: jest.fn(),
      UpdateItemCommand: jest.fn(),
    }));
    jest.mock('@aws-sdk/util-dynamodb', () => ({
      marshall: jest.fn((obj) => obj),
      unmarshall: jest.fn((obj) => obj),
    }));
    jest.mock('@aws-sdk/client-cloudwatch', () => ({
      CloudWatchClient: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
      PutMetricDataCommand: jest.fn(),
    }));

    process.env.TABLE_NAME = 'test-table';
    handler = require('../../lambda/api/index').handler;
  });

  test('GET /health returns 200', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: undefined }); // health ping
    const result = await handler(makeEvent('GET', '/health') as any, {} as any);
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.status).toBe('healthy');
  });

  test('GET /items returns items array', async () => {
    ddbSendMock.mockResolvedValueOnce({ Items: [{ pk: 'USER#test-user', sk: 'ITEM#1', id: '1' }] });
    const result = await handler(makeEvent('GET', '/items') as any, {} as any);
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.items).toHaveLength(1);
  });

  test('GET /items includes nextToken when LastEvaluatedKey is present', async () => {
    ddbSendMock.mockResolvedValueOnce({
      Items: [{ pk: 'USER#test-user', sk: 'ITEM#1', id: '1' }],
      LastEvaluatedKey: { pk: 'USER#test-user', sk: 'ITEM#1' },
    });
    const result = await handler(makeEvent('GET', '/items') as any, {} as any);
    const body = JSON.parse(result.body);
    expect(body.nextToken).toBeDefined();
  });

  test('GET /items/{id} returns 404 when item not found', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: undefined });
    const result = await handler(
      makeEvent('GET', '/items/{id}', { pathParameters: { id: 'missing-id' } }) as any,
      {} as any,
    );
    expect(result.statusCode).toBe(404);
  });

  test('DELETE /items/{id} returns 404 when item does not exist', async () => {
    const err = new Error('The conditional request failed');
    err.name = 'ConditionalCheckFailedException';
    ddbSendMock.mockRejectedValueOnce(err);

    const result = await handler(
      makeEvent('DELETE', '/items/{id}', { pathParameters: { id: 'ghost-id' } }) as any,
      {} as any,
    );
    expect(result.statusCode).toBe(404);
  });

  test('DELETE /items/{id} returns 204 when item exists', async () => {
    ddbSendMock.mockResolvedValueOnce({});
    const result = await handler(
      makeEvent('DELETE', '/items/{id}', { pathParameters: { id: 'real-id' } }) as any,
      {} as any,
    );
    expect(result.statusCode).toBe(204);
  });

  test('POST /items returns 400 for missing body', async () => {
    const result = await handler(makeEvent('POST', '/items') as any, {} as any);
    expect(result.statusCode).toBe(400);
  });

  test('POST /items returns 400 for invalid JSON', async () => {
    const result = await handler(
      makeEvent('POST', '/items', { body: 'not-json' }) as any,
      {} as any,
    );
    expect(result.statusCode).toBe(400);
  });

  test('POST /items returns 201 with valid body', async () => {
    ddbSendMock.mockResolvedValueOnce({});
    const result = await handler(
      makeEvent('POST', '/items', { body: JSON.stringify({ name: 'test' }) }) as any,
      {} as any,
    );
    expect(result.statusCode).toBe(201);
  });

  test('unknown route returns 404', async () => {
    const result = await handler(makeEvent('GET', '/unknown') as any, {} as any);
    expect(result.statusCode).toBe(404);
  });

  test('response includes security headers', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: undefined });
    const result = await handler(makeEvent('GET', '/health') as any, {} as any);
    expect(result.headers!['Strict-Transport-Security']).toContain('max-age=');
    expect(result.headers!['X-Frame-Options']).toBe('DENY');
    expect(result.headers!['Cache-Control']).toBe('no-store');
  });
});

import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from 'aws-lambda';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { randomUUID } from 'crypto';

const ddb = new DynamoDBClient({});
const cw = new CloudWatchClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

async function emitLatency(operation: string, latencyMs: number): Promise<void> {
  await cw.send(new PutMetricDataCommand({
    Namespace: 'CloudAcceleration/Api',
    MetricData: [
      {
        MetricName: 'OperationLatency',
        Value: latencyMs,
        Unit: 'Milliseconds',
        Dimensions: [
          { Name: 'Service', Value: 'cloud-acceleration' },
          { Name: 'Operation', Value: operation },
        ],
      },
    ],
  })).catch(() => {});
}

async function handleHealth(): Promise<APIGatewayProxyResult> {
  const start = Date.now();
  await ddb.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: marshall({ pk: '__health__', sk: '__ping__' }),
  }));
  await emitLatency('Health', Date.now() - start);
  return response(200, { status: 'healthy', timestamp: new Date().toISOString() });
}

async function listItems(principalId: string, nextToken?: string): Promise<APIGatewayProxyResult> {
  const start = Date.now();

  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (nextToken) {
    try {
      exclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64url').toString('utf-8'));
    } catch {
      return response(400, { error: 'Invalid pagination token' });
    }
  }

  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: marshall({ ':pk': `USER#${principalId}`, ':prefix': 'ITEM#' }),
    Limit: 100,
    ExclusiveStartKey: exclusiveStartKey ? marshall(exclusiveStartKey) : undefined,
  }));

  await emitLatency('ListItems', Date.now() - start);

  const items = (result.Items ?? []).map(item => unmarshall(item));
  const responseNextToken = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(unmarshall(result.LastEvaluatedKey))).toString('base64url')
    : undefined;

  return response(200, { items, count: items.length, nextToken: responseNextToken });
}

async function getItem(principalId: string, id: string): Promise<APIGatewayProxyResult> {
  const start = Date.now();
  const result = await ddb.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: marshall({ pk: `USER#${principalId}`, sk: `ITEM#${id}` }),
  }));
  await emitLatency('GetItem', Date.now() - start);
  if (!result.Item) return response(404, { error: 'Not found' });
  return response(200, unmarshall(result.Item));
}

async function createItem(principalId: string, body: string | null): Promise<APIGatewayProxyResult> {
  if (!body) return response(400, { error: 'Request body required' });
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body);
  } catch {
    return response(400, { error: 'Invalid JSON body' });
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const item = {
    pk: `USER#${principalId}`,
    sk: `ITEM#${id}`,
    id,
    entityType: 'ITEM',
    createdAt: now,
    updatedAt: now,
    createdBy: principalId,
    ...data,
  };

  const start = Date.now();
  await ddb.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshall(item),
    ConditionExpression: 'attribute_not_exists(pk)',
  }));
  await emitLatency('CreateItem', Date.now() - start);
  return response(201, item);
}

async function updateItem(principalId: string, id: string, body: string | null): Promise<APIGatewayProxyResult> {
  if (!body) return response(400, { error: 'Request body required' });
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body);
  } catch {
    return response(400, { error: 'Invalid JSON body' });
  }

  const start = Date.now();
  const result = await ddb.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: marshall({ pk: `USER#${principalId}`, sk: `ITEM#${id}` }),
    UpdateExpression: 'SET updatedAt = :now, #data = :data',
    ExpressionAttributeNames: { '#data': 'data' },
    ExpressionAttributeValues: marshall({ ':now': new Date().toISOString(), ':data': data }),
    ConditionExpression: 'attribute_exists(pk)',
    ReturnValues: 'ALL_NEW',
  }));
  await emitLatency('UpdateItem', Date.now() - start);
  if (!result.Attributes) return response(404, { error: 'Not found' });
  return response(200, unmarshall(result.Attributes));
}

async function deleteItem(principalId: string, id: string): Promise<APIGatewayProxyResult> {
  const start = Date.now();
  try {
    await ddb.send(new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ pk: `USER#${principalId}`, sk: `ITEM#${id}` }),
      ConditionExpression: 'attribute_exists(pk)',
    }));
    await emitLatency('DeleteItem', Date.now() - start);
    return response(204, {});
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return response(404, { error: 'Not found' });
    }
    throw err;
  }
}

export const handler = async (
  event: APIGatewayProxyEvent,
  _context: Context,
): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const path = event.resource;
  const id = event.pathParameters?.id;
  const principalId = event.requestContext.authorizer?.sub ?? 'system';

  console.info(JSON.stringify({
    level: 'INFO',
    method,
    path,
    principalId,
    requestId: event.requestContext.requestId,
  }));

  try {
    if (path === '/health' && method === 'GET') return await handleHealth();
    if (path === '/items' && method === 'GET') return await listItems(principalId, event.queryStringParameters?.nextToken ?? undefined);
    if (path === '/items' && method === 'POST') return await createItem(principalId, event.body);
    if (path === '/items/{id}' && method === 'GET' && id) return await getItem(principalId, id);
    if (path === '/items/{id}' && method === 'PUT' && id) return await updateItem(principalId, id, event.body);
    if (path === '/items/{id}' && method === 'DELETE' && id) return await deleteItem(principalId, id);

    return response(404, { error: 'Not found' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    console.error(JSON.stringify({ level: 'ERROR', message: msg, path, method }));
    return response(500, { error: 'Internal server error' });
  }
};

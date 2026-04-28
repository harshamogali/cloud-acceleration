import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from 'aws-lambda';
import { MongoClient, ObjectId, Collection, Db } from 'mongodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { randomUUID } from 'crypto';

const sm = new SecretsManagerClient({});
const cw = new CloudWatchClient({});

const SECRET_ARN = process.env.DOCDB_SECRET_ARN!;
const CLUSTER_ENDPOINT = process.env.DOCDB_CLUSTER_ENDPOINT!;
const CLUSTER_PORT = process.env.DOCDB_CLUSTER_PORT ?? '27017';
const DB_NAME = process.env.DOCDB_DATABASE ?? 'cloud_acceleration';
const COLLECTION_NAME = process.env.DOCDB_COLLECTION ?? 'documents';
// Amazon's bundled CA chain for DocumentDB TLS verification.
// Lambda includes /opt/global-bundle.pem when the docdb-tls layer is attached;
// otherwise the certificate is fetched at cold-start from S3 (see deploy notes).
const TLS_CA_FILE = process.env.DOCDB_TLS_CA_FILE ?? '/opt/global-bundle.pem';

let cachedClient: MongoClient | undefined;
let cachedSecret: { username: string; password: string } | undefined;
let secretExpiresAt = 0;
const SECRET_TTL_MS = 5 * 60 * 1000;

async function getCredentials(): Promise<{ username: string; password: string }> {
  if (cachedSecret && Date.now() < secretExpiresAt) return cachedSecret;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  const parsed = JSON.parse(res.SecretString!) as { username: string; password: string };
  cachedSecret = parsed;
  secretExpiresAt = Date.now() + SECRET_TTL_MS;
  return parsed;
}

async function getCollection(): Promise<Collection> {
  if (!cachedClient) {
    const { username, password } = await getCredentials();
    const uri = `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${CLUSTER_ENDPOINT}:${CLUSTER_PORT}/?tls=true&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false`;
    cachedClient = new MongoClient(uri, {
      tlsCAFile: TLS_CA_FILE,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await cachedClient.connect();
  }
  const db: Db = cachedClient.db(DB_NAME);
  return db.collection(COLLECTION_NAME);
}

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
    Namespace: 'CloudAcceleration/DocDb',
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

function projectDoc(doc: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!doc) return null;
  const { _id, ...rest } = doc as { _id?: ObjectId };
  return { id: _id?.toString(), ...rest };
}

async function listDocuments(principalId: string, limit: number, cursor?: string): Promise<APIGatewayProxyResult> {
  const start = Date.now();
  const collection = await getCollection();
  const filter: Record<string, unknown> = { ownerId: principalId };
  if (cursor) {
    if (!ObjectId.isValid(cursor)) return response(400, { error: 'Invalid cursor' });
    filter._id = { $lt: new ObjectId(cursor) };
  }
  const docs = await collection
    .find(filter)
    .sort({ _id: -1 })
    .limit(Math.min(limit, 100))
    .toArray();
  await emitLatency('ListDocuments', Date.now() - start);
  const nextCursor = docs.length === limit ? docs[docs.length - 1]._id.toString() : undefined;
  return response(200, { items: docs.map(projectDoc), count: docs.length, nextCursor });
}

async function getDocument(principalId: string, id: string): Promise<APIGatewayProxyResult> {
  if (!ObjectId.isValid(id)) return response(400, { error: 'Invalid document id' });
  const start = Date.now();
  const collection = await getCollection();
  const doc = await collection.findOne({ _id: new ObjectId(id), ownerId: principalId });
  await emitLatency('GetDocument', Date.now() - start);
  if (!doc) return response(404, { error: 'Not found' });
  return response(200, projectDoc(doc));
}

async function createDocument(principalId: string, body: string | null): Promise<APIGatewayProxyResult> {
  if (!body) return response(400, { error: 'Request body required' });
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body);
  } catch {
    return response(400, { error: 'Invalid JSON body' });
  }

  const now = new Date().toISOString();
  const doc: Record<string, unknown> = {
    ownerId: principalId,
    createdAt: now,
    updatedAt: now,
    createdBy: principalId,
    requestId: randomUUID(),
    ...data,
  };
  // Strip any caller-supplied id/_id — server controls identity.
  delete doc.id;
  delete doc._id;

  const start = Date.now();
  const collection = await getCollection();
  const result = await collection.insertOne(doc);
  await emitLatency('CreateDocument', Date.now() - start);
  return response(201, projectDoc({ ...doc, _id: result.insertedId }));
}

async function updateDocument(principalId: string, id: string, body: string | null): Promise<APIGatewayProxyResult> {
  if (!ObjectId.isValid(id)) return response(400, { error: 'Invalid document id' });
  if (!body) return response(400, { error: 'Request body required' });
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body);
  } catch {
    return response(400, { error: 'Invalid JSON body' });
  }

  // Disallow client overwrites of identity / ownership / audit fields.
  delete data.id;
  delete data._id;
  delete data.ownerId;
  delete data.createdAt;
  delete data.createdBy;

  const start = Date.now();
  const collection = await getCollection();
  const result = await collection.findOneAndUpdate(
    { _id: new ObjectId(id), ownerId: principalId },
    { $set: { ...data, updatedAt: new Date().toISOString() } },
    { returnDocument: 'after' },
  );
  await emitLatency('UpdateDocument', Date.now() - start);
  if (!result) return response(404, { error: 'Not found' });
  return response(200, projectDoc(result as Record<string, unknown>));
}

async function deleteDocument(principalId: string, id: string): Promise<APIGatewayProxyResult> {
  if (!ObjectId.isValid(id)) return response(400, { error: 'Invalid document id' });
  const start = Date.now();
  const collection = await getCollection();
  const result = await collection.deleteOne({ _id: new ObjectId(id), ownerId: principalId });
  await emitLatency('DeleteDocument', Date.now() - start);
  if (result.deletedCount === 0) return response(404, { error: 'Not found' });
  return response(204, {});
}

async function handleHealth(): Promise<APIGatewayProxyResult> {
  const start = Date.now();
  const collection = await getCollection();
  await collection.estimatedDocumentCount();
  await emitLatency('Health', Date.now() - start);
  return response(200, { status: 'healthy', timestamp: new Date().toISOString() });
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
    if (path === '/documents/health' && method === 'GET') return await handleHealth();
    if (path === '/documents' && method === 'GET') {
      const limit = parseInt(event.queryStringParameters?.limit ?? '50', 10);
      return await listDocuments(principalId, isNaN(limit) ? 50 : limit, event.queryStringParameters?.cursor ?? undefined);
    }
    if (path === '/documents' && method === 'POST') return await createDocument(principalId, event.body);
    if (path === '/documents/{id}' && method === 'GET' && id) return await getDocument(principalId, id);
    if (path === '/documents/{id}' && method === 'PUT' && id) return await updateDocument(principalId, id, event.body);
    if (path === '/documents/{id}' && method === 'DELETE' && id) return await deleteDocument(principalId, id);

    return response(404, { error: 'Not found' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    console.error(JSON.stringify({ level: 'ERROR', message: msg, path, method }));
    return response(500, { error: 'Internal server error' });
  }
};

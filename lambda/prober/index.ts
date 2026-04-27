import { Context } from 'aws-lambda';
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const ddb = new DynamoDBClient({});
const lambda = new LambdaClient({});
const cw = new CloudWatchClient({});
const TABLE_NAME = process.env.TABLE_NAME!;
const API_FUNCTION_NAME = process.env.API_FUNCTION_NAME!;
const PROBE_PK = '__prober__';
const PROBE_SK = '__synthetic__';

interface ProbeResult {
  name: string;
  passed: boolean;
  latencyMs: number;
  error?: string;
}

async function emitMetrics(results: ProbeResult[]): Promise<void> {
  const allPassed = results.every(r => r.passed);

  await cw.send(new PutMetricDataCommand({
    Namespace: 'CloudAcceleration/Prober',
    MetricData: [
      {
        MetricName: 'Availability',
        Value: allPassed ? 1 : 0,
        Unit: 'None',
        Dimensions: [{ Name: 'Service', Value: 'cloud-acceleration' }],
      },
      ...results.map(r => ({
        MetricName: 'ProbeLatency',
        Value: r.latencyMs,
        Unit: 'Milliseconds' as const,
        Dimensions: [
          { Name: 'Service', Value: 'cloud-acceleration' },
          { Name: 'Probe', Value: r.name },
        ],
      })),
      ...results.map(r => ({
        MetricName: 'ProbeSuccess',
        Value: r.passed ? 1 : 0,
        Unit: 'None' as const,
        Dimensions: [
          { Name: 'Service', Value: 'cloud-acceleration' },
          { Name: 'Probe', Value: r.name },
        ],
      })),
    ],
  }));
}

async function probeDynamoWrite(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall({
        pk: PROBE_PK,
        sk: PROBE_SK,
        probedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 300,
      }),
    }));
    return { name: 'dynamo-write', passed: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { name: 'dynamo-write', passed: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

async function probeDynamoRead(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const result = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ pk: PROBE_PK, sk: PROBE_SK }),
      ConsistentRead: true,
    }));
    const passed = !!result.Item;
    return { name: 'dynamo-read', passed, latencyMs: Date.now() - start };
  } catch (err) {
    return { name: 'dynamo-read', passed: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

async function probeDynamoDelete(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await ddb.send(new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ pk: PROBE_PK, sk: PROBE_SK }),
    }));
    return { name: 'dynamo-delete', passed: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { name: 'dynamo-delete', passed: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

async function probeApiFunction(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    // Invoke the API Lambda directly (private — no HTTP) to test end-to-end handler path
    const payload = {
      httpMethod: 'GET',
      resource: '/health',
      path: '/health',
      headers: {},
      queryStringParameters: null,
      pathParameters: null,
      body: null,
      requestContext: {
        requestId: `prober-${Date.now()}`,
        authorizer: { sub: '__prober__' },
      },
      isBase64Encoded: false,
    };

    const res = await lambda.send(new InvokeCommand({
      FunctionName: API_FUNCTION_NAME,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }));

    if (res.FunctionError) {
      return { name: 'api-health', passed: false, latencyMs: Date.now() - start, error: res.FunctionError };
    }

    const body = res.Payload ? JSON.parse(Buffer.from(res.Payload).toString()) : {};
    const passed = body.statusCode === 200;
    return { name: 'api-health', passed, latencyMs: Date.now() - start };
  } catch (err) {
    return { name: 'api-health', passed: false, latencyMs: Date.now() - start, error: String(err) };
  }
}

export const handler = async (_event: unknown, _context: Context): Promise<void> => {
  const overallStart = Date.now();

  const results: ProbeResult[] = [];

  // Run DynamoDB probes sequentially (write → read → delete to maintain consistency)
  results.push(await probeDynamoWrite());
  results.push(await probeDynamoRead());
  results.push(await probeDynamoDelete());

  // Run API function probe
  results.push(await probeApiFunction());

  const allPassed = results.every(r => r.passed);
  const totalLatency = Date.now() - overallStart;

  const logEntry = {
    level: allPassed ? 'INFO' : 'ERROR',
    message: allPassed ? 'PROBE_SUCCESS' : 'PROBE_FAILURE',
    availability: allPassed ? 1 : 0,
    latencyMs: totalLatency,
    probes: results,
  };

  if (allPassed) {
    console.info(JSON.stringify(logEntry));
  } else {
    console.error(JSON.stringify(logEntry));
  }

  await emitMetrics(results);
};

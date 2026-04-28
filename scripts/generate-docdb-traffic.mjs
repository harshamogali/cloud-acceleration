#!/usr/bin/env node
/**
 * Drives synthetic CRUD traffic against the cloud-acceleration-docdb-api Lambda.
 * The Lambda runs inside the VPC and connects to DocumentDB over TLS, so this
 * script exercises the full Lambda -> DocumentDB path while running from
 * outside the VPC.
 *
 * Usage:
 *   node scripts/generate-docdb-traffic.mjs [count]
 *
 *   count - number of documents to create (default 50)
 */
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const client = new LambdaClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const FN = 'cloud-acceleration-docdb-api';
const PRINCIPAL = process.env.PRINCIPAL ?? 'load-tester';
const COUNT = parseInt(process.argv[2] ?? '50', 10);
const CONCURRENCY = 5;

function makeEvent(method, resource, overrides = {}) {
  return {
    httpMethod: method,
    resource,
    pathParameters: null,
    queryStringParameters: null,
    body: null,
    requestContext: {
      requestId: `traffic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      authorizer: { sub: PRINCIPAL },
    },
    ...overrides,
  };
}

async function invoke(event) {
  const start = Date.now();
  const res = await client.send(new InvokeCommand({
    FunctionName: FN,
    Payload: JSON.stringify(event),
  }));
  const latencyMs = Date.now() - start;
  const payload = JSON.parse(Buffer.from(res.Payload).toString());
  let body;
  try { body = JSON.parse(payload.body); } catch { body = payload.body; }
  return { statusCode: payload.statusCode, body, latencyMs };
}

async function runBatch(makers) {
  const out = [];
  for (let i = 0; i < makers.length; i += CONCURRENCY) {
    const batch = makers.slice(i, i + CONCURRENCY).map(fn => fn());
    const results = await Promise.allSettled(batch);
    for (const r of results) {
      out.push(r.status === 'fulfilled' ? r.value : { error: r.reason.message });
    }
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return out;
}

function summarize(label, results) {
  const ok = results.filter(r => r.statusCode >= 200 && r.statusCode < 300);
  const fail = results.filter(r => !r.statusCode || r.statusCode >= 400);
  const lats = ok.map(r => r.latencyMs).sort((a, b) => a - b);
  const p = n => lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * n))] : 0;
  console.log(`${label.padEnd(12)}  ok=${ok.length}/${results.length}  fail=${fail.length}  p50=${p(0.5)}ms  p95=${p(0.95)}ms  p99=${p(0.99)}ms`);
  if (fail.length) {
    const sample = fail.slice(0, 3).map(r => `[${r.statusCode ?? 'ERR'}] ${JSON.stringify(r.body ?? r.error).slice(0, 120)}`);
    sample.forEach(s => console.log(`              ${s}`));
  }
}

async function main() {
  console.log(`Target: ${FN}  principal=${PRINCIPAL}  count=${COUNT}`);
  console.log('');

  console.log('1) Health check');
  const h = await invoke(makeEvent('GET', '/documents/health'));
  console.log(`   ${h.statusCode}  ${JSON.stringify(h.body)}  (${h.latencyMs}ms)`);
  if (h.statusCode !== 200) {
    console.error('Health check failed - aborting'); process.exit(1);
  }

  console.log(`\n2) Creating ${COUNT} documents`);
  const creates = await runBatch(
    Array.from({ length: COUNT }, (_, i) => () => invoke(makeEvent('POST', '/documents', {
      body: JSON.stringify({
        name: `loadtest-doc-${i}`,
        value: Math.round(Math.random() * 10000),
        nested: { kind: i % 3 === 0 ? 'alpha' : i % 3 === 1 ? 'beta' : 'gamma', priority: i % 5 },
        tags: ['load-test', `cohort-${Math.floor(i / 10)}`],
      }),
    }))),
  );
  summarize('CREATE', creates);
  const ids = creates.filter(r => r.statusCode === 201).map(r => r.body.id);

  console.log(`\n3) Listing documents (paginated)`);
  const lists = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const r = await invoke(makeEvent('GET', '/documents', {
      queryStringParameters: { limit: '20', ...(cursor ? { cursor } : {}) },
    }));
    lists.push(r);
    if (r.statusCode !== 200 || !r.body.nextCursor) break;
    cursor = r.body.nextCursor;
  }
  summarize('LIST', lists);
  console.log(`   pages=${lists.length}  total returned=${lists.reduce((s, r) => s + (r.body?.count ?? 0), 0)}`);

  console.log(`\n4) Reading ${Math.min(20, ids.length)} documents`);
  const reads = await runBatch(
    ids.slice(0, 20).map(id => () => invoke(makeEvent('GET', '/documents/{id}', { pathParameters: { id } }))),
  );
  summarize('GET', reads);

  console.log(`\n5) Updating ${Math.min(10, ids.length)} documents`);
  const updates = await runBatch(
    ids.slice(0, 10).map((id, i) => () => invoke(makeEvent('PUT', '/documents/{id}', {
      pathParameters: { id },
      body: JSON.stringify({ updatedField: `v${i}`, touched: new Date().toISOString() }),
    }))),
  );
  summarize('UPDATE', updates);

  console.log(`\n6) Deleting ${Math.min(5, ids.length)} documents`);
  const deletes = await runBatch(
    ids.slice(0, 5).map(id => () => invoke(makeEvent('DELETE', '/documents/{id}', { pathParameters: { id } }))),
  );
  summarize('DELETE', deletes);

  console.log(`\nDone. Created ids in this run (excluding deleted): ${ids.length - 5}`);
}

main().catch(err => { console.error(err); process.exit(1); });

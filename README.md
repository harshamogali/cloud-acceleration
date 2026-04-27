# Cloud Acceleration

A production-grade, NIST 800-53 compliant AWS CDK application for financial institutions. All API traffic stays within the AWS network — no internet gateway, no NAT gateway. Cross-account access is provided via AWS PrivateLink.

## Contents

- [Architecture Overview](#architecture-overview)
- [Stack Layout](#stack-layout)
- [NIST 800-53 Control Mapping](#nist-800-53-control-mapping)
- [Prerequisites](#prerequisites)
- [First-Time Setup](#first-time-setup)
- [Deploying](#deploying)
- [Cross-Account Access via PrivateLink](#cross-account-access-via-privatelink)
- [API Reference](#api-reference)
- [Authentication](#authentication)
- [Monitoring & Alerting](#monitoring--alerting)
- [Backup & Recovery](#backup--recovery)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Configuration Reference](#configuration-reference)
- [Security Notes](#security-notes)

---

## Architecture Overview

```
Consumer Account                       Provider Account
─────────────────                      ──────────────────────────────────────────────────────
                                       ┌─── Private VPC (10.0.0.0/16, no IGW, no NAT) ──────┐
VPC Interface      ──PrivateLink──▶   NLB ──▶  execute-api VPC Endpoint ENIs                │
Endpoint                               │                                                      │
                                       │  ┌── Isolated Subnets (per AZ) ─────────────────┐   │
                                       │  │                                               │   │
                                       │  │  Lambda Authorizer ◀── API Gateway (private) │   │
                                       │  │                              │                │   │
                                       │  │  Lambda API Handler ◀────────┘                │   │
                                       │  │       │                                       │   │
                                       │  │  DynamoDB ◀──────────────────────────────────┘   │
                                       │  └───────────────────────────────────────────────┘   │
                                       │                                                      │
                                       │  Lambda Prober ──── every 60s ──▶ DynamoDB + API    │
                                       │                                                      │
                                       │  VPC Interface Endpoints (11 total):                │
                                       │  API GW · Lambda · CloudWatch · CW Logs             │
                                       │  CW Events · Secrets Manager · KMS                  │
                                       │  STS · SNS · SSM · DynamoDB (Gateway)               │
                                       └──────────────────────────────────────────────────────┘
                                                       │
                                              SNS Alarm Topic
                                                       │
                                          Lambda PagerDuty Bridge
                                                       │
                                           PagerDuty Events API v2
```

All AWS service calls (DynamoDB, Secrets Manager, KMS, CloudWatch, Lambda, SNS) are routed over VPC Interface Endpoints. No traffic leaves the AWS network.

---

## Stack Layout

The application comprises 10 CloudFormation stacks deployed in dependency order:

| Stack | Logical ID | Purpose |
|-------|-----------|---------|
| `KmsStack` | `CloudAccelKms` | Customer-managed KMS key shared by all stacks |
| `NetworkingStack` | `CloudAccelNetworking` | Private VPC, VPC endpoints, flow logs |
| `DataStack` | `CloudAccelData` | DynamoDB table, GSI, AWS Backup plan |
| `AlertingStack` | `CloudAccelAlerting` | SNS alarm topic, PagerDuty bridge Lambda |
| `AuthorizerStack` | `CloudAccelAuthorizer` | JWT signing key, Lambda authorizer |
| `ApiHandlerStack` | `CloudAccelApiHandler` | CRUD API Lambda |
| `ProberStack` | `CloudAccelProber` | Synthetic health prober (every 60s) |
| `ApiStack` | `CloudAccelApi` | Private API Gateway, token authorizer, routes |
| `PrivateLinkStack` | `CloudAccelPrivateLink` | Internal NLB, VPC Endpoint Service |
| `ObservabilityStack` | `CloudAccelObservability` | CloudWatch alarms, dashboard, metric filters |

### Why separate stacks?

- **Independent lifecycle** — KMS keys and data stores can be retained independently of application code.
- **Least-privilege IAM** — Each Lambda's execution role is defined in its own stack with only the permissions it needs.
- **No cross-stack cycles** — `ApiStack` uses an explicit IAM role (`assumeRole`) on the `TokenAuthorizer` so CDK does not add a Lambda resource policy that would create a dependency loop back to `AuthorizerStack`.

---

## NIST 800-53 Control Mapping

| Control | Description | Implementation |
|---------|-------------|----------------|
| **AC-3** | Access Enforcement | API Gateway resource policy denies all requests not from the designated VPC endpoint |
| **AC-6** | Least Privilege | Each Lambda execution role is scoped to the exact actions it requires; no `*` actions |
| **AC-17** | Remote Access | All API access is private; requires a VPC endpoint in the consumer account |
| **AU-12** | Audit Record Generation | VPC flow logs, API Gateway access logs, Lambda structured logs — all encrypted and retained 1 year |
| **CP-9** | Information System Backup | AWS Backup: daily (35 days), weekly (90 days), monthly (7 years) |
| **IA-2** | Identification & Authentication | Every API request requires a signed JWT; `timingSafeEqual` prevents timing attacks |
| **IA-5** | Authenticator Management | JWT signing key and PagerDuty key stored in Secrets Manager (encrypted with CMK); 64-char random secret |
| **SC-7** | Boundary Protection | VPC has no internet gateway, no NAT gateway; all egress blocked except HTTPS to VPC endpoints |
| **SC-8** | Transmission Confidentiality | TLS enforced end-to-end; DynamoDB table policy denies non-TLS access (`aws:SecureTransport: false`) |
| **SC-12** | Cryptographic Key Management | Single CMK with annual rotation; key policy limits service access to CloudWatch Logs and SNS |
| **SC-28** | Protection of Information at Rest | DynamoDB, SNS topics, Secrets Manager secrets, and all log groups encrypted with CMK |
| **SI-4** | Information System Monitoring | CloudWatch alarms on error rate, latency, auth failures, 4XX/5XX; PagerDuty P1 on SLO breach |
| **SI-6** | Security Function Verification | Health prober runs every 60 seconds; performs write→read→delete probe plus a direct API invocation |

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | 22.x or later |
| AWS CDK CLI | 2.x (`npm install -g aws-cdk`) |
| AWS CLI | v2 |
| AWS credentials | Configured via `aws configure` or environment variables |

Bootstrap your account/region before the first deploy:

```bash
cdk bootstrap aws://ACCOUNT_ID/REGION
```

---

## First-Time Setup

```bash
git clone https://github.com/harshamogali/cloud-acceleration.git
cd cloud-acceleration
npm install
```

---

## Deploying

### Deploy all stacks

```bash
cdk deploy --all
```

CDK resolves the dependency order automatically. Stacks deploy sequentially based on their cross-stack references.

### Deploy a specific stack

```bash
cdk deploy CloudAccelKms
cdk deploy CloudAccelNetworking
```

### Tag the environment

```bash
cdk deploy --all --context environment=staging
```

The `environment` tag defaults to `production` if not provided.

### View synthesised CloudFormation templates

```bash
cdk synth
```

### Destroy (non-production only)

Resources with `RemovalPolicy.RETAIN` (KMS key, DynamoDB table, log groups, backup vault, Secrets Manager secrets) are **not** deleted by `cdk destroy`. They must be removed manually to prevent accidental data loss.

```bash
cdk destroy --all
```

---

## Cross-Account Access via PrivateLink

The `PrivateLinkStack` exposes the private API to other AWS accounts without VPC peering. An internal NLB fronts the execute-api VPC endpoint, and a VPC Endpoint Service wraps the NLB.

```
Consumer VPC
  └── VPC Interface Endpoint
        └── PrivateLink
              └── NLB (cloud-acceleration-pl-nlb)
                    └── execute-api VPC Endpoint ENI IPs (3 AZs)
                          └── Private API Gateway
```

### Step 1 — Get the Endpoint Service name

After deploying `CloudAccelPrivateLink`, retrieve the service name from the stack output:

```bash
aws cloudformation describe-stacks \
  --stack-name CloudAccelPrivateLink \
  --query 'Stacks[0].Outputs[?OutputKey==`EndpointServiceName`].OutputValue' \
  --output text
```

### Step 2 — Allow the consumer account (optional pre-approval)

Edit `bin/cloud-acceleration.ts` to pre-approve a consumer account before they connect:

```typescript
const privateLink = new PrivateLinkStack(app, 'CloudAccelPrivateLink', {
  ...
  allowedConsumerPrincipals: [
    new iam.ArnPrincipal('arn:aws:iam::CONSUMER_ACCOUNT_ID:root'),
  ],
});
```

Without this, each new connection request must be manually accepted (see Step 4).

### Step 3 — Consumer creates a VPC Interface Endpoint

Run in the **consumer account**:

```bash
aws ec2 create-vpc-endpoint \
  --vpc-id vpc-CONSUMER_VPC_ID \
  --vpc-endpoint-type Interface \
  --service-name com.amazonaws.vpce.REGION.vpce-svc-XXXXXXXXXX \
  --subnet-ids subnet-XXXXXXXXXX subnet-YYYYYYYYYY \
  --security-group-ids sg-XXXXXXXXXX \
  --region REGION
```

### Step 4 — Accept the connection request

Run in the **provider account** (skip if the consumer is pre-approved):

```bash
aws ec2 accept-vpc-endpoint-connections \
  --service-id vpce-svc-XXXXXXXXXX \
  --vpc-endpoint-ids vpce-YYYYYYYYYY
```

### Step 5 — Call the API from the consumer

```bash
curl -H "Authorization: Bearer <JWT>" \
  https://API_ID.execute-api.REGION.amazonaws.com/v1/items
```

---

## API Reference

Base path: `https://{api-id}.execute-api.{region}.amazonaws.com/v1`

All endpoints except `/health` require a valid JWT in the `Authorization: Bearer <token>` header.

### GET /health

No authentication required. Performs a DynamoDB connectivity check.

**Response 200**
```json
{
  "status": "healthy",
  "timestamp": "2025-04-27T10:00:00.000Z"
}
```

---

### GET /items

Returns up to 100 items owned by the authenticated principal.

| Parameter | Location | Required | Description |
|-----------|----------|----------|-------------|
| `nextToken` | Query string | No | Opaque pagination cursor returned by a previous response |

**Response 200**
```json
{
  "items": [
    { "id": "uuid", "createdAt": "...", "updatedAt": "...", "...": "..." }
  ],
  "count": 3,
  "nextToken": "eyJwayI6..."
}
```

When `nextToken` is absent from the response, there are no further pages.

---

### POST /items

Creates a new item.

**Request body** — any JSON object. Reserved server-assigned keys: `pk`, `sk`, `id`, `entityType`, `createdAt`, `updatedAt`, `createdBy`.

**Response 201** — the created item including all server-assigned fields.  
**Response 400** — missing or invalid JSON body.

---

### GET /items/{id}

**Response 200** — the item.  
**Response 404** — item not found.

---

### PUT /items/{id}

Replaces the `data` attribute of the item and refreshes `updatedAt`.

**Request body** — JSON object with new field values.

**Response 200** — the full updated item.  
**Response 404** — item not found.

---

### DELETE /items/{id}

**Response 204** — deleted successfully.  
**Response 404** — item not found.

---

### Common response headers

All responses include:

```
Content-Type: application/json
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Cache-Control: no-store
```

---

## Authentication

The API uses HMAC-SHA256 signed JWTs. The signing key lives in Secrets Manager at `/cloud-acceleration/jwt-signing-key` (auto-generated at deploy time; rotate manually).

### Required JWT payload fields

| Field | Type | Description |
|-------|------|-------------|
| `sub` | string | Principal identifier — used as the DynamoDB partition namespace |
| `scope` | string[] | Permission scopes (validated by the authorizer; not yet enforced per-route) |
| `exp` | number | Expiry as Unix timestamp |
| `iat` | number | Issued-at as Unix timestamp |
| `jti` | string | Unique token ID (used for deduplication in logs) |

### Generating a test token

```typescript
import * as crypto from 'crypto';

function signJwt(payload: object, secret: string): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc(payload);
  const sig = crypto.createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

const now = Math.floor(Date.now() / 1000);
const token = signJwt({
  sub: 'test-user',
  scope: ['read', 'write'],
  exp: now + 3600,
  iat: now,
  jti: crypto.randomUUID(),
}, SECRET_FROM_SECRETS_MANAGER);
```

### Retrieve the signing key

```bash
aws secretsmanager get-secret-value \
  --secret-id /cloud-acceleration/jwt-signing-key \
  --query SecretString \
  --output text
```

### Cache behaviour

API Gateway caches authorizer results for 5 minutes (`resultsCacheTtl`). The Lambda execution environment also caches the signing key for 5 minutes. Allow up to 10 minutes after a key rotation before all cached results expire.

---

## Monitoring & Alerting

### CloudWatch dashboard

`CloudAcceleration-Operations` — accessible in the CloudWatch console or via the `DashboardUrl` output of `CloudAccelObservability`.

| Row | Widgets |
|-----|---------|
| **API Health** | Invocations & errors · Latency (P50/P95/P99) · API GW 4XX/5XX |
| **Auth & Security** | Auth failure count · Authorizer latency · Lambda throttles |
| **DynamoDB** | Consumed capacity · Per-operation P99 latency · Throttles & system errors |
| **PrivateLink NLB** | Healthy/unhealthy hosts · Active flow count · Processed bytes |
| **Prober** | Functional availability · End-to-end latency · Active alarm status |

### Alarms

| Alarm name | Condition | Notes |
|------------|-----------|-------|
| `cloud-acceleration-api-error-rate` | Error rate > 1% for 2 × 5 min | P1 — included in SLO composite |
| `cloud-acceleration-api-p99-latency` | P99 > 10 s for 3 × 5 min | |
| `cloud-acceleration-auth-failures` | > 10 failures in 5 min | Brute-force indicator — NIST SI-4 |
| `cloud-acceleration-dynamo-system-errors` | Any DynamoDB 500 | |
| `cloud-acceleration-dynamo-throttles` | > 10 throttled requests in 2 × 5 min | |
| `cloud-acceleration-prober-availability` | Availability < 1.0 for 2 × 5 min | P1 — included in SLO composite |
| `cloud-acceleration-prober-latency` | P95 > 5 s for 3 × 5 min | |
| `cloud-acceleration-apigw-5xx` | > 5 errors in 2 × 5 min | |
| `cloud-acceleration-apigw-4xx` | > 100 errors in 2 × 5 min | Attack-pattern indicator |
| `cloud-acceleration-api-throttles` | Any Lambda throttle | |
| `cloud-acceleration-nlb-unhealthy-hosts` | Any unhealthy NLB target | |
| **`cloud-acceleration-slo-critical`** | Composite: availability OR error-rate | **Triggers PagerDuty P1** |

### PagerDuty integration

All alarms publish to the `cloud-acceleration-alarms` SNS topic, which triggers the `PagerDutyBridge` Lambda. The Lambda calls the [PagerDuty Events API v2](https://developer.pagerduty.com/docs/ZG9jOjExMDI5NTgx-send-an-alert-event) (`trigger` on ALARM state, `resolve` on OK state).

Store the integration key before deploying:

```bash
aws secretsmanager put-secret-value \
  --secret-id /cloud-acceleration/pagerduty-integration-key \
  --secret-string "YOUR_PAGERDUTY_INTEGRATION_KEY"
```

> **Note:** The PagerDuty bridge Lambda is intentionally **not placed inside the VPC** — it requires outbound internet access to reach `events.pagerduty.com`. In a fully air-gapped environment, route traffic through an HTTPS proxy or replace the bridge with an AWS Direct Connect-backed egress path.

---

## Backup & Recovery

AWS Backup runs automatically against the DynamoDB table (`cloud-acceleration-data`).

| Schedule | Retention | Purpose |
|----------|-----------|---------|
| Daily at 02:00 UTC | 35 days | Operational rollback window |
| Weekly on Sunday at 03:00 UTC | 90 days | Short-term compliance |
| Monthly on the 1st at 04:00 UTC | 7 years (2,555 days) | Financial regulatory compliance |

The backup vault (`cloud-acceleration-vault`) has a compliance lock: recovery points cannot be deleted or their lifecycle updated by anyone except the account root principal. This satisfies NIST CP-9.

DynamoDB PITR is also enabled, allowing restore to any second within the past 35 days without waiting for a backup window.

### Restore via PITR

```bash
aws dynamodb restore-table-to-point-in-time \
  --source-table-name cloud-acceleration-data \
  --target-table-name cloud-acceleration-data-restored \
  --restore-date-time "2025-04-27T10:00:00Z"
```

### Restore from AWS Backup

```bash
# List recovery points
aws backup list-recovery-points-by-backup-vault \
  --backup-vault-name cloud-acceleration-vault

# Start a restore job
aws backup start-restore-job \
  --recovery-point-arn arn:aws:backup:REGION:ACCOUNT:recovery-point:... \
  --metadata '{"targetTableName":"cloud-acceleration-data-restored"}'
```

---

## Testing

### Run all tests

```bash
npm test
```

### Test layout

```
test/
├── cloud-acceleration.test.ts   # Smoke test: KmsStack synthesises
├── stacks/
│   ├── kms.test.ts              # CMK rotation, alias, removal policy, key policy
│   ├── networking.test.ts       # VPC isolation, endpoint count, flow logs
│   ├── data.test.ts             # DynamoDB PITR, TTL, backup plan, GSI, removal policy
│   └── api.test.ts              # Private API, token authorizer, routes, access logs
└── lambda/
    ├── authorizer.test.ts       # JWT verify/deny paths, cache TTL, algorithm rejection
    └── api.test.ts              # Routing, pagination nextToken, 404 on missing items
```

**Stack tests** use `aws-cdk-lib/assertions` to synthesise each stack and assert CloudFormation properties. No AWS credentials required.

**Lambda unit tests** use Jest mocks for all AWS SDK clients. No network calls are made.

```bash
# Run only Lambda tests
npx jest test/lambda

# Run only stack synthesis tests
npx jest test/stacks

# Run with coverage
npx jest --coverage
```

### CDK diff

Check what will change before deploying:

```bash
cdk diff --all
```

---

## Project Structure

```
cloud-acceleration/
├── bin/
│   └── cloud-acceleration.ts        # CDK App: instantiates all stacks in order
├── lambda/
│   ├── api/
│   │   └── index.ts                 # REST API handler (CRUD + pagination)
│   ├── authorizer/
│   │   └── index.ts                 # JWT token authorizer (HMAC-SHA256)
│   ├── pagerduty-bridge/
│   │   └── index.ts                 # SNS → PagerDuty Events API v2
│   └── prober/
│       └── index.ts                 # Synthetic health prober
├── lib/
│   ├── constants.ts                 # Lambda runtime, architecture, env defaults
│   ├── constructs/
│   │   └── vpc-lambda-function.ts   # Shared VPC-attached Lambda construct
│   └── stacks/
│       ├── kms-stack.ts             # Customer-managed KMS key
│       ├── networking-stack.ts      # Private VPC + 11 VPC endpoints
│       ├── data-stack.ts            # DynamoDB + AWS Backup (3 tiers)
│       ├── alerting-stack.ts        # SNS topics + PagerDuty bridge
│       ├── authorizer-stack.ts      # JWT Secrets Manager secret + Lambda
│       ├── api-handler-stack.ts     # CRUD API Lambda
│       ├── prober-stack.ts          # Health prober + EventBridge rule
│       ├── api-stack.ts             # Private API Gateway + token authorizer
│       ├── privatelink-stack.ts     # NLB + VPC Endpoint Service
│       └── observability-stack.ts   # Alarms + dashboard + metric filters
├── test/
│   ├── stacks/                      # CDK synthesis assertion tests
│   └── lambda/                      # Lambda unit tests (mocked SDK)
├── cdk.json
├── jest.config.js
├── package.json
└── tsconfig.json
```

### Key design decisions

**`VpcLambdaFunction` construct** (`lib/constructs/vpc-lambda-function.ts`)  
All three VPC-attached Lambdas (authorizer, API handler, prober) share the same security baseline: isolated subnet placement, HTTPS-only egress security group, KMS-encrypted log group with 1-year retention, IAM role with X-Ray + VPC execution access, Lambda Insights, and `NodejsFunction` bundling via esbuild. Each stack passes stack-specific `extraPolicies` for additional permissions.

**No TokenAuthorizer dependency cycle**  
CDK's `TokenAuthorizer` normally calls `handler.addPermission()`, which adds a Lambda resource policy referencing the API ARN — creating a circular CloudFormation dependency between `AuthorizerStack` and `ApiStack`. Passing `assumeRole` (an IAM role the API Gateway can assume) causes CDK to skip that call and use the role instead, breaking the cycle.

**PrivateLink ENI IP resolution**  
The NLB requires the private IPs of the execute-api endpoint's ENIs, which are only available at deploy time. Two chained `AwsCustomResource` constructs (CloudFormation custom resources) call `DescribeVpcEndpoints` then `DescribeNetworkInterfaces`, resolving ENI IPs as CloudFormation tokens that the NLB target group consumes.

---

## Configuration Reference

### Environment variables (Lambda)

All VPC-attached Lambdas receive a common baseline from `VpcLambdaFunction`. Stack-specific additions follow.

| Variable | Value | Lambdas |
|----------|-------|---------|
| `AWS_NODEJS_CONNECTION_REUSE_ENABLED` | `1` | All |
| `NODE_OPTIONS` | `--enable-source-maps` | All |
| `POWERTOOLS_SERVICE_NAME` | `cloud-acceleration` | All |
| `LOG_LEVEL` | `INFO` | All |
| `JWT_SECRET_ARN` | Secrets Manager ARN | Authorizer |
| `TABLE_NAME` | DynamoDB table name | API handler, Prober |
| `API_FUNCTION_NAME` | Lambda function name | Prober |
| `PD_SECRET_ARN` | Secrets Manager ARN | PagerDuty bridge |

### Resource names

| Resource | Name |
|----------|------|
| KMS alias | `alias/cloud-acceleration-platform` |
| DynamoDB table | `cloud-acceleration-data` |
| SNS alarm topic | `cloud-acceleration-alarms` |
| SNS PagerDuty topic | `cloud-acceleration-pagerduty` |
| Lambda — API handler | `cloud-acceleration-api` |
| Lambda — Authorizer | `cloud-acceleration-authorizer` |
| Lambda — Prober | `cloud-acceleration-prober` |
| Lambda — PagerDuty bridge | `cloud-acceleration-pagerduty-bridge` |
| NLB | `cloud-acceleration-pl-nlb` |
| EventBridge rule | `cloud-acceleration-prober` |
| CloudWatch dashboard | `CloudAcceleration-Operations` |
| AWS Backup vault | `cloud-acceleration-vault` |

### CloudWatch log groups

| Log group | Retention |
|-----------|-----------|
| `/cloud-acceleration/vpc-flow-logs` | 1 year |
| `/cloud-acceleration/apigw-access` | 1 year |
| `/cloud-acceleration/authorizer` | 1 year |
| `/cloud-acceleration/api` | 1 year |
| `/cloud-acceleration/prober` | 1 year |
| `/cloud-acceleration/pagerduty-bridge` | 1 year |

### Secrets Manager paths

| Path | Contents |
|------|----------|
| `/cloud-acceleration/jwt-signing-key` | 64-char HMAC-SHA256 signing key (auto-generated at deploy) |
| `/cloud-acceleration/pagerduty-integration-key` | PagerDuty Events API v2 routing key (set manually) |

### API Gateway throttling

Applied at the `v1` stage:

| Setting | Value |
|---------|-------|
| Burst limit | 500 req/s |
| Rate limit | 1,000 req/s |

### Lambda specifications

All VPC-attached Lambdas (API handler, authorizer, prober):

| Setting | Value |
|---------|-------|
| Runtime | Node.js 22.x |
| Architecture | ARM64 |
| Memory | 512 MB |
| Default timeout | 29 s (prober: 2 min) |
| Tracing | X-Ray active |
| Insights | Lambda Insights 1.0.229.0 |
| Bundler | esbuild (minified + source maps) |

---

## Security Notes

- **Retained resources** — KMS key, DynamoDB table, all log groups, backup vault, and Secrets Manager secrets have `RemovalPolicy.RETAIN`. `cdk destroy` does not remove them; manual cleanup is required.
- **Backup compliance lock** — The `DenyDeleteRecoveryPoint` policy on the backup vault prevents deletion by anyone except the account root, even with full IAM permissions. This is intentional for financial audit compliance.
- **Timing-safe JWT verification** — Signature comparison uses `crypto.timingSafeEqual`, preventing timing oracle attacks that could leak signature bytes.
- **PrivateLink acceptance** — The VPC Endpoint Service has `acceptanceRequired: true`. Every new consumer must be explicitly approved; there is no auto-accept.
- **API Gateway resource policy** — An explicit `DENY` on all requests that do not include `aws:sourceVpce` matching the designated endpoint ID means that even AWS principal credentials cannot call the API from outside the VPC.
- **PagerDuty bridge internet access** — The bridge Lambda is the only component with outbound internet access. It does not sit inside the VPC and cannot reach internal resources. If this is unacceptable for your threat model, replace with an HTTPS proxy or SNS-to-webhook integration routed via Direct Connect.

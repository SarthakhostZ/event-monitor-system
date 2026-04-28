# Event Monitor System

A serverless, event-driven monitoring system built on AWS that captures real-time events from multiple sources, processes them asynchronously, classifies severity using rule-based logic and AI (OpenAI), and triggers alerts automatically.

**Tech Stack:** Node.js 20.x · AWS Lambda · DynamoDB · API Gateway · SQS · SNS · OpenAI API · Serverless Framework

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Local Setup](#local-setup)
- [Environment Variables](#environment-variables)
- [Running Locally](#running-locally)
- [Testing](#testing)
- [Deployment](#deployment)
- [API Documentation](#api-documentation)
- [Project Structure](#project-structure)
- [Adding a New Event Source](#adding-a-new-event-source)
- [Adding a New Alert Channel](#adding-a-new-alert-channel)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
Event Sources (APIs · Webhooks · Manual)
        │  HTTPS
        ▼
┌─────────────────────┐
│    API Gateway       │  JWT auth · rate limiting · Joi validation
└──────────┬──────────┘
           │  Lambda Invoke
     ┌─────┴──────┐
     ▼            ▼
 eventIngest   webhookReceiver
     │            │
     └─────┬──────┘
           │  SQS SendMessage (202 returned to caller)
           ▼
    ┌─────────────┐        ┌─────────┐
    │  SQS Queue  │──fail─▶│   DLQ   │
    └──────┬──────┘        └─────────┘
           │  batch trigger (10 msgs)
           ▼
    ┌─────────────┐
    │eventProcessor│  rule engine · idempotent write
    └──────┬──────┘
           │  DynamoDB write
           ▼
    ┌─────────────┐       ┌────────────────┐
    │ EventsTable  │──────▶│ eventAnalyzer  │  OpenAI gpt-4o-mini
    │  (Streams)   │       │ circuit breaker│  + circuit breaker
    └─────────────┘       └───────┬────────┘
                                   │  if severity ≥ high
                                   ▼
                           ┌──────────────┐
                           │  SNS Topic   │  CriticalAlerts
                           └──────┬───────┘
                                   │  fan-out
                                   ▼
                           ┌──────────────┐
                           │alertDispatcher│  email · Slack · SMS
                           └──────────────┘
```

Full diagram with labeled arrows: [docs/architecture.md](docs/architecture.md)

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20.x | [nodejs.org](https://nodejs.org) |
| npm | 9+ | bundled with Node.js |
| AWS CLI | v2 | `brew install awscli` |
| Serverless Framework | 4.x | `npm i -g serverless` |
| Java 11+ | (for DynamoDB Local) | required for integration tests |

---

## Local Setup

### 1. Clone & install dependencies

```bash
git clone <repo-url>
cd event-monitor-system
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` with your values — see [Environment Variables](#environment-variables) for a full reference.

### 3. Configure AWS credentials

```bash
aws configure
# AWS Access Key ID:     <your-key>
# AWS Secret Access Key: <your-secret>
# Default region:        ap-south-1
# Default output format: json
```

### 4. Start DynamoDB Local (for integration tests)

```bash
# Download DynamoDB Local (one-time)
mkdir -p .dynamodb
curl -L https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz \
  | tar xz -C .dynamodb

# Run it
java -Djava.library.path=.dynamodb/DynamoDBLocal_lib \
     -jar .dynamodb/DynamoDBLocal.jar -sharedDb -port 8000

# Create local tables (in a separate terminal)
node scripts/create-tables.js
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in all values. Required variables:

```env
# ── AWS ──────────────────────────────────────────────────────
AWS_REGION=ap-south-1
DYNAMODB_EVENTS_TABLE=event-monitor-system-events-dev
DYNAMODB_ALERTS_TABLE=event-monitor-system-alerts-dev
DYNAMODB_METRICS_TABLE=event-monitor-system-metrics-dev
SQS_QUEUE_URL=https://sqs.ap-south-1.amazonaws.com/<account>/EventProcessingQueue-dev
SNS_TOPIC_ARN=arn:aws:sns:ap-south-1:<account>:CriticalAlerts-dev

# ── Authentication ────────────────────────────────────────────
JWT_SECRET=your-strong-secret-min-32-chars
JWT_ISSUER=event-monitor-system
JWT_AUDIENCE=event-monitor-api
JWT_EXPIRY=1h

# ── OpenAI ───────────────────────────────────────────────────
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
AI_ENABLED=true
AI_MAX_RETRIES=3
AI_CIRCUIT_BREAKER_THRESHOLD=5
AI_CIRCUIT_BREAKER_TIMEOUT_MS=300000

# ── Email (SMTP) ──────────────────────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
ALERT_EMAIL_TO=ops-team@company.com

# ── Slack ─────────────────────────────────────────────────────
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# ── Application ───────────────────────────────────────────────
LOG_LEVEL=info
STAGE=dev
RATE_LIMIT_DEFAULT=100
EVENT_TTL_DAYS=30
```

---

## Running Locally

```bash
# Start the API on http://localhost:3000
npm run dev
# or
npx serverless offline

# Tail specific Lambda logs (deployed environments only)
npx serverless logs -f eventIngest -t
npx serverless logs -f eventProcessor -t
npx serverless logs -f eventAnalyzer -t
```

Local endpoints mirror deployed paths:
- `POST http://localhost:3000/dev/events`
- `POST http://localhost:3000/dev/webhook/{source}`
- `GET  http://localhost:3000/dev/events`
- `GET  http://localhost:3000/dev/dashboard/stats`
- `GET  http://localhost:3000/dev/health`

---

## Testing

```bash
# All tests with coverage report (target: >80%)
npm test

# Unit tests only (mocked AWS SDK, no infrastructure needed)
npm run test:unit

# Integration tests (requires DynamoDB Local on :8000)
npm run test:integration

# Load / performance tests
npm run test:load

# Lint
npx eslint src/ --fix
```

**Coverage target:** >80% lines. Run `npm test -- --coverage` to check.

**SLA thresholds (load tests):**
- p99 latency < 5 seconds
- Error rate < 1%
- Zero data loss

---

## Deployment

```bash
# Deploy to dev (default)
npx serverless deploy --stage dev

# Deploy to staging
npx serverless deploy --stage staging

# Deploy to production (requires manual approval via CI/CD)
npx serverless deploy --stage prod

# Remove a stack
npx serverless remove --stage dev
```

**CI/CD pipeline** (GitHub Actions — `.github/workflows/deploy.yml`):
```
push to main → lint → unit tests → integration tests
  → deploy staging → smoke test → manual approval → deploy prod → smoke test
```

**Stage differences:**

| Stage | DynamoDB | AI | Rate Limits | DynamoDB Capacity |
|-------|-----------|----|-------------|-------------------|
| dev | On-demand | Disabled | Relaxed | On-demand |
| staging | On-demand | Enabled | Production-like | On-demand |
| prod | Provisioned | Enabled | Enforced | Provisioned |

---

## API Documentation

### Authentication

All endpoints (except `GET /health`) require a JWT in the `Authorization` header:

```
Authorization: Bearer <token>
```

Webhook endpoints use source-specific HMAC signature verification instead:

```
X-Hub-Signature-256: sha256=<hmac>   # GitHub
Stripe-Signature: t=...,v1=...       # Stripe
X-Webhook-Secret: <shared-secret>    # Generic
```

**Roles:**

| Role | Permissions |
|------|-------------|
| `admin` | All endpoints including cost metrics and config |
| `operator` | Create events, view dashboard, view alerts |
| `viewer` | Read-only dashboard access |

---

### POST /events

Ingest a new event. Returns immediately with 202; processing is async.

**Auth:** JWT (operator or admin)
**Rate limit:** 100 req/min

**Request body:**

```json
{
  "title": "High error rate detected",
  "description": "Error rate exceeded 5% over last 5 minutes on service payment-api",
  "type": "error",
  "severity": "high",
  "source": "api",
  "metadata": {
    "service": "payment-api",
    "errorRate": 5.4,
    "region": "ap-south-1"
  },
  "idempotencyKey": "payment-api-high-err-2026-04-10T14:00:00Z"
}
```

**Fields:**

| Field | Type | Required | Values | Max length |
|-------|------|----------|--------|-----------|
| `title` | string | Yes | — | 200 chars |
| `description` | string | Yes | — | 2000 chars |
| `type` | string | Yes | `error` `warning` `info` `critical` | — |
| `severity` | string | Yes | `low` `medium` `high` `critical` | — |
| `source` | string | Yes | `api` `webhook` `manual` | — |
| `metadata` | object | No | any key-value pairs | — |
| `idempotencyKey` | string | No | unique key for dedup | 128 chars |

**Response `202 Accepted`:**

```json
{
  "eventId": "evt_01HXZ3K2MJN5Q7ABCDEF",
  "status": "queued",
  "message": "Event accepted for processing"
}
```

**Error responses:**

| Status | Reason |
|--------|--------|
| 400 | Validation failed — see `errors` array in body |
| 401 | Missing or invalid JWT |
| 429 | Rate limit exceeded — check `X-RateLimit-Remaining` |

---

### POST /webhook/{source}

Receive events from external systems. Source-specific signature verification is applied.

**Auth:** HMAC signature (source-specific)
**Rate limit:** 500 req/min
**Supported sources:** `github`, `stripe`, `pagerduty`, `generic`

**Request (GitHub example):**

```bash
curl -X POST https://api.example.com/webhook/github \
  -H "X-Hub-Signature-256: sha256=<hmac>" \
  -H "X-GitHub-Event: push" \
  -H "Content-Type: application/json" \
  -d '{"repository": {"name": "my-repo"}, "pusher": {"name": "saurabh"}}'
```

**Response `202 Accepted`:**

```json
{
  "eventId": "evt_01HXZ3K2MJN5Q7XYZABC",
  "status": "queued"
}
```

---

### GET /events

Fetch events with optional filters. Paginated.

**Auth:** JWT (viewer or above)
**Rate limit:** 200 req/min

**Query parameters:**

| Param | Type | Description | Example |
|-------|------|-------------|---------|
| `severity` | string | Filter by severity | `severity=high` |
| `source` | string | Filter by source | `source=webhook` |
| `type` | string | Filter by event type | `type=error` |
| `status` | string | Filter by processing status | `status=analyzed` |
| `from` | ISO date | Start of time range | `from=2026-04-01T00:00:00Z` |
| `to` | ISO date | End of time range | `to=2026-04-10T23:59:59Z` |
| `limit` | number | Page size (max 100) | `limit=25` |
| `nextToken` | string | Pagination cursor from previous response | — |

**Response `200 OK`:**

```json
{
  "events": [
    {
      "eventId": "evt_01HXZ3K2MJN5Q7ABCDEF",
      "timestamp": "2026-04-10T14:32:01.000Z",
      "title": "High error rate detected",
      "type": "error",
      "severity": "high",
      "source": "api",
      "status": "analyzed",
      "aiSummary": "Payment API error rate spiked to 5.4% possibly due to downstream DB latency.",
      "aiSeverity": "high",
      "aiRecommendation": "Check RDS connection pool metrics and review recent deployments.",
      "metadata": { "service": "payment-api", "errorRate": 5.4 }
    }
  ],
  "count": 1,
  "nextToken": "eyJldmVudElkIjoiZXZ0XzAxSFh..."
}
```

---

### GET /events/{eventId}

Fetch a single event by ID.

**Auth:** JWT (viewer or above)

**Response `200 OK`:** Single event object (same shape as list items above)

**Response `404 Not Found`:**

```json
{ "error": "Event not found", "eventId": "evt_..." }
```

---

### GET /dashboard/stats

Aggregate statistics for the last 24 hours, 7 days, and 30 days.

**Auth:** JWT (viewer or above)
**Rate limit:** 60 req/min

**Response `200 OK`:**

```json
{
  "periods": {
    "24h": {
      "total": 342,
      "bySeverity": { "low": 180, "medium": 95, "high": 52, "critical": 15 },
      "byType": { "error": 120, "warning": 180, "info": 27, "critical": 15 },
      "bySource": { "api": 200, "webhook": 130, "manual": 12 },
      "alertsSent": 67,
      "aiAnalyzed": 162
    },
    "7d": { "..." : "..." },
    "30d": { "..." : "..." }
  },
  "generatedAt": "2026-04-10T15:00:00.000Z"
}
```

---

### GET /dashboard/trends

Time-series trend data grouped by hour.

**Auth:** JWT (viewer or above)

**Query parameters:**

| Param | Default | Description |
|-------|---------|-------------|
| `period` | `24h` | `24h` `7d` `30d` |
| `groupBy` | `hour` | `hour` `day` |

**Response `200 OK`:**

```json
{
  "period": "24h",
  "groupBy": "hour",
  "series": [
    { "timestamp": "2026-04-10T14:00:00Z", "count": 18, "severity": "high", "alerts": 4 },
    { "timestamp": "2026-04-10T13:00:00Z", "count": 12, "severity": "medium", "alerts": 1 }
  ]
}
```

---

### GET /metrics/cost

AI usage and cost tracking data. Admin only.

**Auth:** JWT (admin only)

**Response `200 OK`:**

```json
{
  "period": "30d",
  "ai": {
    "totalCalls": 4821,
    "totalTokens": 9642000,
    "estimatedCostUSD": 4.82,
    "model": "gpt-4o-mini"
  },
  "lambda": {
    "invocations": 52300,
    "estimatedCostUSD": 0.21
  },
  "dynamodb": {
    "readUnits": 182000,
    "writeUnits": 54000,
    "estimatedCostUSD": 1.44
  }
}
```

---

### GET /health

System health check. No authentication required.

**Response `200 OK`:**

```json
{
  "status": "healthy",
  "timestamp": "2026-04-10T15:00:00.000Z",
  "version": "1.0.0",
  "stage": "dev",
  "dependencies": {
    "dynamodb": "healthy",
    "sqs": "healthy",
    "sns": "healthy",
    "openai": "healthy"
  }
}
```

**Response `503 Service Unavailable`:** Returned when any critical dependency is unhealthy.

---

## Project Structure

```
event-monitor-system/
├── src/
│   ├── handlers/            # Lambda entry points (thin — delegate to services)
│   │   ├── eventIngest.js
│   │   ├── webhookReceiver.js
│   │   ├── eventProcessor.js
│   │   ├── eventAnalyzer.js
│   │   ├── alertDispatcher.js
│   │   ├── dashboardAPI.js
│   │   └── healthCheck.js
│   ├── services/            # Business logic (no Lambda/AWS coupling)
│   │   ├── ruleEngine.js
│   │   ├── aiService.js
│   │   ├── dynamoService.js
│   │   ├── emailService.js
│   │   └── webhookTransformers.js
│   ├── models/              # Joi validation schemas
│   │   ├── eventModel.js
│   │   ├── alertModel.js
│   │   └── metricModel.js
│   ├── middleware/
│   │   ├── auth.js          # JWT verification & RBAC
│   │   ├── rateLimiter.js   # Token-bucket via DynamoDB
│   │   ├── validator.js     # Input sanitization, size limits, XSS
│   │   └── security.js      # CORS, headers, IP allowlist
│   ├── config/
│   │   ├── config.js        # Environment loader (validates at cold start)
│   │   └── rules.json       # Rule engine definitions
│   ├── templates/
│   │   └── alertEmail.html  # HTML email template
│   └── utils/
│       ├── logger.js        # Winston structured JSON
│       ├── retry.js         # Exponential backoff
│       └── idempotency.js   # Duplicate detection
├── infrastructure/
│   └── cloudformation/
│       └── dynamodb.yml
├── tests/
│   ├── unit/
│   ├── integration/
│   └── load/
├── docs/
│   ├── architecture.md
│   └── cost-analysis.md
├── scripts/
│   ├── create-tables.js     # Create DynamoDB Local tables
│   └── create-tables-aws.js
├── serverless.yml
├── package.json
├── .env.example
└── README.md
```

---

## Adding a New Event Source (Webhook)

1. Add a transformer in [src/services/webhookTransformers.js](src/services/webhookTransformers.js):

```js
function transformNewSource(payload) {
  return {
    source: 'new-source',
    type: 'error',         // error | warning | info | critical
    severity: 'medium',    // low | medium | high | critical
    title: payload.title,
    description: payload.body,
    metadata: { originalId: payload.id }
  };
}
```

2. Add signature verification in `webhookReceiver.js` for the new source.
3. Add classification rules in [src/config/rules.json](src/config/rules.json).
4. Deploy: `npx serverless deploy --stage dev`

---

## Adding a New Alert Channel

1. Create a sender in `src/services/` (e.g. `pagerdutyService.js`).
2. Register it in `alertDispatcher.js` channel routing map.
3. Map severity → channel in the dispatcher config.
4. Add required environment variables to `.env` and `serverless.yml`.
5. Write unit tests for the new channel.

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Events not processing | SQS queue depth in CloudWatch; check DLQ for failed messages |
| AI analysis missing | Verify `AI_ENABLED=true`; check circuit breaker status in logs; verify `OPENAI_API_KEY` |
| Alerts not sending | Confirm SNS subscription is active; check SMTP credentials; inspect AlertsTable status field |
| High latency | Lambda duration metrics in CloudWatch; DynamoDB throttling; cold start frequency |
| Duplicate events | Verify `idempotencyKey` is being sent; check DynamoDB conditional write logs |
| 429 Rate limit errors | Check `X-RateLimit-Remaining` header; adjust limits in `config.js` if legitimate traffic |
| 401 Unauthorized | Token expired (`JWT_EXPIRY`); wrong `JWT_SECRET`; missing `Authorization` header |
| DynamoDB Local not connecting | Confirm Java is installed; check port 8000 is free; run `create-tables.js` first |

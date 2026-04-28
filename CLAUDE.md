# CLAUDE.md — AI-Assisted Event Monitoring & Alert System

## Project Overview

This is a **serverless, event-driven monitoring system** built on AWS that captures real-time events from multiple sources, processes them asynchronously, classifies their importance using rule-based logic and AI (OpenAI), and triggers alerts automatically.

**Tech Stack:** Node.js 20.x | AWS Lambda | DynamoDB | API Gateway | SQS | SNS | OpenAI API | Serverless Framework

---

## Project Structure

```
event-monitor-system/
├── src/
│   ├── handlers/                # Lambda function entry points
│   │   ├── eventIngest.js       # POST /events — receives & validates events
│   │   ├── webhookReceiver.js   # POST /webhook/{source} — receives external webhooks
│   │   ├── eventProcessor.js    # SQS consumer — processes event batches
│   │   ├── eventAnalyzer.js     # DynamoDB Streams trigger — AI analysis
│   │   ├── alertDispatcher.js   # SNS trigger — sends alerts to channels
│   │   ├── dashboardAPI.js      # GET /dashboard/* — stats, trends, costs
│   │   └── healthCheck.js       # GET /health
│   ├── services/                # Business logic (no AWS/Lambda coupling)
│   │   ├── ruleEngine.js        # Configurable rule evaluation engine
│   │   ├── aiService.js         # OpenAI integration with circuit breaker
│   │   ├── dynamoService.js     # DynamoDB CRUD operations
│   │   ├── emailService.js      # Email formatting & sending (nodemailer)
│   │   └── webhookTransformers.js # Source-specific webhook → event mappers
│   ├── models/                  # Joi validation schemas
│   │   ├── eventModel.js        # Event schema & validation
│   │   ├── alertModel.js        # Alert schema & validation
│   │   └── metricModel.js       # Metric schema & validation
│   ├── middleware/              # Request pipeline middleware
│   │   ├── auth.js              # JWT verification & RBAC (admin/operator/viewer)
│   │   ├── rateLimiter.js       # Token-bucket rate limiting via DynamoDB
│   │   ├── validator.js         # Input sanitization, size limits, XSS prevention
│   │   └── security.js          # CORS, security headers, IP allowlisting
│   ├── config/
│   │   ├── config.js            # Environment-specific configuration loader
│   │   └── rules.json           # Rule engine definitions (JSON, no code changes needed)
│   ├── templates/
│   │   └── alertEmail.html      # Responsive HTML email template for alerts
│   └── utils/
│       ├── logger.js            # Winston structured JSON logger
│       ├── retry.js             # Exponential backoff retry helper
│       └── idempotency.js       # Duplicate event detection helper
├── infrastructure/
│   └── cloudformation/          # Additional CF templates if needed
├── tests/
│   ├── unit/                    # Jest unit tests (mock all external deps)
│   │   ├── ruleEngine.test.js
│   │   ├── eventModel.test.js
│   │   ├── aiService.test.js
│   │   └── rateLimiter.test.js
│   ├── integration/             # End-to-end flow tests (dynamodb-local)
│   │   └── eventFlow.test.js
│   └── load/                    # Performance & chaos testing
│       └── loadTest.js
├── docs/
│   ├── architecture.md          # Mermaid architecture diagram
│   └── cost-analysis.md         # Serverless vs traditional cost comparison
├── .github/
│   └── workflows/
│       └── deploy.yml           # CI/CD: lint → test → staging → prod
├── serverless.yml               # All Lambda functions, resources, IAM roles
├── package.json
├── .env.example                 # All required environment variables
├── Makefile                     # make dev, make test, make deploy, make logs
└── README.md
```

---

## Architecture & Data Flow

```
Event Sources (APIs, Webhooks, Manual)
        │
        ▼
┌─────────────────┐
│   API Gateway    │  ← JWT auth + rate limiting + validation
└────────┬────────┘
         │
         ▼
┌─────────────────┐       ┌──────────────┐
│  eventIngest /   │──────▶│  SQS Queue   │  ← async decoupling
│  webhookReceiver │       │  (with DLQ)  │
└─────────────────┘       └──────┬───────┘
                                  │
                                  ▼
                          ┌──────────────┐
                          │ eventProcessor│  ← batch processing (10 msgs)
                          │  (Lambda)     │  ← rule engine classification
                          └──────┬───────┘
                                  │
                                  ▼
                          ┌──────────────┐
                          │  DynamoDB     │  ← EventsTable, AlertsTable, MetricsTable
                          │  (Streams ON) │
                          └──────┬───────┘
                                  │ DynamoDB Streams
                                  ▼
                          ┌──────────────┐
                          │ eventAnalyzer │  ← OpenAI gpt-4o-mini
                          │  (Lambda)     │  ← summary, severity, recommendation
                          └──────┬───────┘
                                  │ if severity ≥ high
                                  ▼
                          ┌──────────────┐
                          │  SNS Topic   │  ← CriticalAlerts
                          └──────┬───────┘
                                  │
                                  ▼
                          ┌──────────────┐
                          │alertDispatcher│  ← email, Slack, SMS
                          │  (Lambda)     │
                          └──────────────┘
```

---

## Key Design Decisions

- **SQS between ingestion and processing**: Events are queued, not processed inline. This decouples the API response from processing latency. The API returns 202 immediately.
- **DynamoDB Streams for AI trigger**: Instead of calling OpenAI inside the processor, a separate Lambda is triggered by DB writes. This keeps the processor fast and the AI layer independently scalable.
- **Circuit breaker on AI**: If OpenAI fails 5 consecutive times, AI is disabled for 5 minutes and the system falls back to rule-based classification only. No human intervention needed.
- **Idempotency keys**: Every event carries an `idempotencyKey`. DynamoDB conditional writes prevent duplicates even under retry storms.
- **Dead Letter Queues**: SQS DLQ catches messages that fail processing after max retries. These are preserved for manual inspection — zero data loss.

---

## DynamoDB Tables

### EventsTable
| Key | Type | Description |
|---|---|---|
| `eventId` (PK) | String (UUID) | Unique event identifier |
| `timestamp` (SK) | String (ISO) | Event creation time |
| `source` | String | "api" / "webhook" / "manual" |
| `type` | String | "error" / "warning" / "info" / "critical" |
| `severity` | String | "low" / "medium" / "high" / "critical" |
| `title` | String | Event title (max 200 chars) |
| `description` | String | Event details (max 2000 chars) |
| `metadata` | Map | Flexible key-value pairs |
| `status` | String | "new" → "processing" → "analyzed" → "alerted" |
| `aiSummary` | String | AI-generated summary |
| `aiSeverity` | String | AI-predicted severity |
| `aiRecommendation` | String | AI-suggested action |
| `idempotencyKey` | String | Duplicate prevention key |
| `ttl` | Number | Auto-expire epoch (30 days) |

**GSIs:** `severity-index` (PK: severity, SK: timestamp), `source-index` (PK: source, SK: timestamp)
**Streams:** Enabled (NEW_IMAGE) — triggers eventAnalyzer Lambda

### AlertsTable
| Key | Type | Description |
|---|---|---|
| `alertId` (PK) | String (UUID) | Unique alert identifier |
| `timestamp` (SK) | String (ISO) | Alert sent time |
| `eventId` | String | Reference to source event |
| `channels` | List | ["email", "slack"] |
| `status` | String | "sent" / "failed" / "retrying" |
| `retryCount` | Number | 0–3 |

### MetricsTable
| Key | Type | Description |
|---|---|---|
| `metricKey` (PK) | String | e.g., "events_by_severity:high:2026-04-10T14" |
| `timestamp` (SK) | String (ISO) | Aggregation window |
| `value` | Number | Counter or gauge value |
| `dimensions` | Map | Grouping metadata |

---

## API Endpoints

| Method | Path | Auth | Handler | Description |
|---|---|---|---|---|
| POST | `/events` | JWT | eventIngest | Ingest a new event |
| POST | `/webhook/{source}` | Signature | webhookReceiver | Receive external webhook |
| GET | `/events` | JWT | dashboardAPI | List events (filtered, paginated) |
| GET | `/events/{eventId}` | JWT | dashboardAPI | Single event detail |
| GET | `/dashboard/stats` | JWT | dashboardAPI | Aggregate stats (24h/7d/30d) |
| GET | `/dashboard/trends` | JWT | dashboardAPI | Time-series trend data |
| GET | `/metrics/cost` | JWT (admin) | dashboardAPI | Cost tracking data |
| GET | `/health` | None | healthCheck | System health status |

**Rate Limits:** POST /events 100/min, POST /webhook 500/min, GET endpoints 200/min, dashboard 60/min

---

## Environment Variables

```env
# AWS
AWS_REGION=ap-south-1
DYNAMODB_EVENTS_TABLE=EventsTable
DYNAMODB_ALERTS_TABLE=AlertsTable
DYNAMODB_METRICS_TABLE=MetricsTable
SQS_QUEUE_URL=https://sqs.ap-south-1.amazonaws.com/xxxx/EventProcessingQueue
SNS_TOPIC_ARN=arn:aws:sns:ap-south-1:xxxx:CriticalAlerts

# Auth
JWT_SECRET=<your-secret>
JWT_ISSUER=event-monitor-system
JWT_AUDIENCE=event-monitor-api
JWT_EXPIRY=1h

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
AI_ENABLED=true
AI_MAX_RETRIES=3
AI_CIRCUIT_BREAKER_THRESHOLD=5
AI_CIRCUIT_BREAKER_TIMEOUT_MS=300000

# Email (SMTP or SES)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
ALERT_EMAIL_TO=ops-team@company.com

# App
LOG_LEVEL=info
STAGE=dev
RATE_LIMIT_DEFAULT=100
EVENT_TTL_DAYS=30
```

---

## Commands

```bash
# Development
npm install                      # install dependencies
npx serverless offline           # run API locally on port 3000
make dev                         # alias for above

# Testing
npm test                         # run all tests with coverage
npm run test:unit                # unit tests only
npm run test:integration         # integration tests (needs dynamodb-local)
npm run test:load                # load/performance tests

# Linting
npx eslint src/ --fix

# Deployment
npx serverless deploy --stage dev       # deploy to dev
npx serverless deploy --stage staging   # deploy to staging
npx serverless deploy --stage prod      # deploy to production
make deploy                             # deploy to default stage

# Logs
npx serverless logs -f eventIngest -t   # tail ingest logs
npx serverless logs -f eventProcessor -t
npx serverless logs -f eventAnalyzer -t
npx serverless logs -f alertDispatcher -t
make logs                               # tail all function logs

# Remove
npx serverless remove --stage dev       # tear down dev environment
```

---

## Code Conventions

- **Handlers are thin**: They parse the trigger event, call a service, and return a response. No business logic in handlers.
- **Services are pure**: Business logic lives in `/src/services/`. Services receive plain objects and return plain objects. They do not import `aws-lambda` types or reference `event.Records`.
- **Validation at the boundary**: All input is validated via Joi schemas in handlers or middleware before reaching services.
- **Structured logging**: Use `src/utils/logger.js` (Winston). Every log line is JSON with `requestId`, `eventId`, `function`, `duration`. Never use `console.log`.
- **Error handling**: Every handler wraps its body in try/catch. Errors are logged with full context and a clean HTTP response is returned. Never let raw stack traces reach the client.
- **Idempotency**: All writes use DynamoDB conditional expressions on `idempotencyKey`. Retries are safe.
- **Config from environment**: No hardcoded values. Everything configurable lives in environment variables loaded via `src/config/config.js`. The config loader validates that all required vars are present at cold start.

---

## Rule Engine

Rules are defined in `src/config/rules.json` — no code changes needed to add rules. Format:

```json
{
  "rules": [
    {
      "id": "high-error-rate",
      "priority": 1,
      "condition": {
        "field": "type",
        "operator": "equals",
        "value": "error",
        "and": {
          "field": "metadata.count",
          "operator": "greaterThan",
          "value": 50
        }
      },
      "action": {
        "setSeverity": "high",
        "triggerAlert": true
      }
    }
  ]
}
```

Supported operators: `equals`, `contains`, `greaterThan`, `lessThan`, `regex`, `exists`. Conditions can be nested with `and` / `or`.

---

## AI Integration

- **Model**: `gpt-4o-mini` (cost-efficient, fast)
- **Trigger**: DynamoDB Streams on EventsTable (INSERT events with status "processing")
- **Skip condition**: Events already classified as "low" by rule engine are not sent to AI
- **Output**: `{ summary, severity, recommendation, rootCause, confidence }`
- **Fallback**: If AI fails or confidence < 50%, rule engine result is used
- **Circuit breaker**: 5 consecutive failures → AI disabled for 5 minutes → auto re-enable
- **Cost tracking**: Token usage logged to MetricsTable per invocation

---

## Authentication & Authorization

**JWT Roles:**
| Role | Permissions |
|---|---|
| `admin` | Full access — all endpoints, cost data, config |
| `operator` | Create events, view dashboard, view alerts |
| `viewer` | Read-only dashboard access |

**Webhook Auth:** Source-specific signature verification (GitHub HMAC-SHA256, Stripe signature, or shared secret in `X-Webhook-Secret` header).

**API Keys:** Supported as alternative to JWT via `X-API-Key` header. Keys are hashed before storage. Rate-limited per key.

---

## Testing Strategy

| Layer | Tool | What it covers |
|---|---|---|
| Unit | Jest + mocks | Individual functions, rule engine, models, AI service |
| Integration | Jest + dynamodb-local | Full event flow: ingest → process → analyze → alert |
| Load | Custom script | Throughput, latency percentiles (p50/p95/p99), error rates |
| Chaos | Custom helpers | AI failure, DynamoDB throttling, SQS delays |

**Coverage target:** >80%. Run `npm test -- --coverage` to check.

**SLA thresholds (load tests):**
- p99 latency < 5 seconds
- Error rate < 1%
- Zero data loss

---

## Deployment Stages

| Stage | DynamoDB Mode | AI Enabled | Rate Limits | Purpose |
|---|---|---|---|---|
| `dev` | On-demand | Disabled | Relaxed | Local development |
| `staging` | On-demand | Enabled | Production-like | Pre-production testing |
| `prod` | Provisioned | Enabled | Enforced | Production |

CI/CD via GitHub Actions: push to `main` → lint → unit tests → integration tests → deploy staging → smoke test → manual approval → deploy prod → smoke test.

---

## Cost Optimization Notes

- **Lambda memory**: eventIngest and alertDispatcher use 128MB. eventProcessor and eventAnalyzer use 256MB. Right-size based on CloudWatch metrics after initial deployment.
- **DynamoDB TTL**: Events auto-expire after 30 days. No manual cleanup needed.
- **AI call batching**: Similar events within a 1-minute window can be batched into a single OpenAI call.
- **S3 archival**: Events older than 7 days are archived to S3 (cheaper storage) via DynamoDB TTL + Streams.
- **Provisioned concurrency**: Consider for eventIngest Lambda in prod to eliminate cold starts on critical path.
- **Reserved capacity**: If traffic is predictable, DynamoDB reserved capacity saves ~75% vs on-demand.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Events not processing | SQS queue depth in CloudWatch. Check DLQ for failed messages. |
| AI analysis missing | Verify `AI_ENABLED=true`. Check circuit breaker status in logs. Check OpenAI API key. |
| Alerts not sending | Check SNS subscription is confirmed. Verify SMTP credentials. Check AlertsTable for status. |
| High latency | Check Lambda duration metrics. Look for DynamoDB throttling. Check cold start frequency. |
| Duplicate events | Verify `idempotencyKey` is being sent. Check DynamoDB conditional write logs. |
| Rate limit errors (429) | Check `X-RateLimit-Remaining` header. Adjust limits in config if legitimate traffic. |

---

## Adding a New Event Source (Webhook)

1. Add a transformer function in `src/services/webhookTransformers.js`:
   ```js
   function transformNewSource(payload) {
     return { source: 'new-source', type: '...', severity: '...', title: '...', description: '...', metadata: {} };
   }
   ```
2. Add signature verification logic in `webhookReceiver.js` for the new source.
3. Add rules for the new source in `src/config/rules.json`.
4. Deploy: `npx serverless deploy --stage dev`

---

## Adding a New Alert Channel

1. Create a sender function in `src/services/` (e.g., `slackService.js`).
2. Register the channel in `alertDispatcher.js` channel routing map.
3. Add the channel to severity → channel mapping.
4. Add required environment variables to `.env` and `serverless.yml`.
5. Add unit tests for the new channel.

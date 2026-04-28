# Event Monitoring & Alert System — Complete System Guide

> **Who this is for:** Developers, DevOps engineers, and technical leads who need to understand, set up, test, and operate this system. It covers what the system does, how authentication works, how to send your first event, how webhooks plug in, and every common error you will encounter.

---

## Table of Contents

1. [What the System Does](#1-what-the-system-does)
2. [User Roles & Access Control](#2-user-roles--access-control)
3. [How Authentication Works](#3-how-authentication-works)
4. [How a New User Starts](#4-how-a-new-user-starts)
5. [Step-by-Step Usage Guide](#5-step-by-step-usage-guide)
6. [Webhook Integration](#6-webhook-integration)
7. [Alert System](#7-alert-system)
8. [Rule Engine](#8-rule-engine)
9. [AI Analysis](#9-ai-analysis)
10. [Dashboard & Metrics APIs](#10-dashboard--metrics-apis)
11. [Common Errors & Fixes](#11-common-errors--fixes)
12. [Important Limitations](#12-important-limitations)
13. [Optional Enhancements](#13-optional-enhancements)

---

## 1. What the System Does

This is a **serverless, event-driven monitoring backend** built on Node.js + AWS. It accepts events from any source, processes them asynchronously, classifies their severity using rules and AI, and fires alerts automatically. It is entirely API-first — there is no UI bundled with it.

### Core Capabilities at a Glance

```
External systems (APIs, Stripe, GitHub, Datadog…)
        │
        ▼ HTTPS
┌─────────────────────┐
│  REST API / Webhooks │  ← JWT or API key auth, rate limiting, Joi validation
└──────────┬──────────┘
           │ 202 Accepted immediately
           ▼
     ┌───────────┐
     │ SQS Queue │  ← async decoupling — the API never blocks on processing
     └─────┬─────┘
           │ batch of 10
           ▼
  ┌────────────────┐
  │ Rule Engine    │  ← classifies severity from rules.json (no code changes needed)
  │ + DynamoDB     │  ← stores every event with idempotency protection
  └────────┬───────┘
           │ DynamoDB Streams
           ▼
  ┌────────────────┐
  │ AI Analyzer    │  ← OpenAI gpt-4o-mini adds summary, root cause, recommendation
  └────────┬───────┘
           │ if severity ≥ high
           ▼
     ┌───────────┐
     │ SNS Topic │
     └─────┬─────┘
           │
           ▼
  ┌────────────────┐
  │ Alert Channels │  ← Email (HTML), Slack, SMS
  └────────────────┘
```

### What Happens to Every Event

| Stage | What Happens |
|---|---|
| Ingest | Event is validated (Joi schema), assigned a UUID, queued in SQS. API returns `202 Accepted` in < 50 ms. |
| Process | SQS consumer picks up the batch, runs the rule engine, and writes to DynamoDB with idempotency protection. |
| Analyze | DynamoDB Streams triggers the AI Lambda. OpenAI returns summary, severity, root cause, and confidence score. |
| Alert | If severity is `high` or `critical`, SNS publishes the alert, which fans out to email, Slack, and/or SMS. |
| Dashboard | Any authenticated user can query events, stats, and trends via the REST API. |

### Event Sources Supported

| Source | How It Reaches the System | Auth |
|---|---|---|
| Your own services | `POST /events` with a JSON body | JWT or API key |
| GitHub | `POST /webhook/github` | HMAC-SHA256 (`X-Hub-Signature-256`) |
| Stripe | `POST /webhook/stripe` | Stripe signature header |
| Datadog | `POST /webhook/datadog` | Shared secret (`X-Webhook-Secret`) |
| Any other system | `POST /webhook/generic` | Shared secret (`X-Webhook-Secret`) |

---

## 2. User Roles & Access Control

Three roles are built in. Every JWT and API key carries exactly one role.

| Role | What They Can Do |
|---|---|
| `admin` | Everything — create events, delete events, view all alerts, view cost metrics, manage users |
| `operator` | Create events, view events, view dashboard, view alerts, acknowledge and resolve alerts, post webhooks |
| `viewer` | Read-only — list events, view dashboard stats and trends |

### Permission Map (Exact)

```
admin    → * (all routes, all operations)
operator → create:events, read:events, read:dashboard, read:alerts, create:webhooks
viewer   → read:events, read:dashboard
```

### Which Routes Require Which Role

| Method | Path | Minimum Role |
|---|---|---|
| `POST` | `/auth/register` | Public (no auth) |
| `POST` | `/auth/login` | Public (no auth) |
| `GET` | `/auth/me` | Any authenticated user |
| `GET` | `/health` | Public (no auth) |
| `GET` | `/events` | `viewer` or above |
| `POST` | `/events` | `operator` or `admin` |
| `GET` | `/events/:id` | `viewer` or above |
| `DELETE` | `/events/:id` | `admin` only |
| `GET` | `/alerts` | Any authenticated user |
| `PATCH` | `/alerts/:id/acknowledge` | `operator` or `admin` |
| `PATCH` | `/alerts/:id/resolve` | `operator` or `admin` |
| `POST` | `/webhook/:source` | Webhook signature (no JWT) |

---

## 3. How Authentication Works

The system supports **two authentication methods**. Both methods work on every protected route.

### Method A — JWT Bearer Token

A JWT is issued on login and must be sent in every request:

```
Authorization: Bearer <your-jwt-token>
```

**Token contents (decoded):**
```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "role": "operator",
  "permissions": ["create:events", "read:events", "read:dashboard"],
  "iss": "event-monitor-system",
  "aud": "event-monitor-api",
  "exp": 1234567890
}
```

Tokens are verified against `JWT_SECRET` (HS256) or a PEM key pair (RS256 if `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` are set). They are cached in memory for 5 minutes to avoid repeated cryptographic verification on every request.

**Token expiry** is set by `JWT_EXPIRES_IN` (default: `7d`). After expiry the user must log in again.

### Method B — API Key

An API key is a 64-character hex string. Send it in the `X-Api-Key` header:

```
X-Api-Key: a3f8d2c9e1b47f6...
```

API keys are hashed (SHA-256) before storage — the raw key is never saved. Each key is rate-limited to 200 requests per minute independently of the JWT rate limit.

### Webhook Authentication (Different from above)

Webhooks from external services use **source-specific signature verification**, not JWT:

| Source | Header Checked |
|---|---|
| GitHub | `X-Hub-Signature-256` (HMAC-SHA256 of the payload using your webhook secret) |
| Stripe | `Stripe-Signature` |
| Datadog | `X-Webhook-Secret` (shared secret) |
| Generic | `X-Webhook-Secret` (shared secret) |

Webhooks do **not** require a user account.

---

## 4. How a New User Starts

> **Important:** This system does NOT have a sign-up UI or a login page. It is a pure API backend. Authentication is done programmatically.

### Flow A — Quick Start (Dev / Local)

This is the fastest way to test everything locally. No infrastructure required.

**Step 1:** Create a `.env` file from the example:

```bash
cp .env.example .env
```

**Step 2:** Edit `.env` — at minimum set these values:

```env
NODE_ENV=development
APP_PORT=3000
JWT_SECRET=my-dev-secret-change-in-prod
DYNAMODB_ENDPOINT=http://localhost:8000
DYNAMODB_EVENTS_TABLE=events
DYNAMODB_USERS_TABLE=users
DYNAMODB_ALERTS_TABLE=alerts
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=local
```

**Step 3:** Start DynamoDB Local (Docker):

```bash
docker run -p 8000:8000 amazon/dynamodb-local
```

**Step 4:** Start the API server:

```bash
npm install
node server.js
# or: npm run dev
```

**Step 5:** Register your first admin user:

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "securepassword123",
    "role": "admin"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "id": "uuid-here",
    "email": "admin@example.com",
    "role": "admin",
    "createdAt": "2026-04-12T10:00:00.000Z"
  }
}
```

**Step 6:** Log in to get your JWT:

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "securepassword123"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

Save that token. Use it in all subsequent requests as `Authorization: Bearer <token>`.

---

### Flow B — Production Setup

In production, you do not want `role: "admin"` to be freely registerable. The recommended approach:

1. **Seed the admin user** via a one-time script or database migration. Set the `role` field directly in DynamoDB.
2. **Restrict registration** — modify the `/auth/register` route to require an existing admin JWT for `role: "admin"` assignments (add `authorize('admin')` guard before the handler for admin-role registrations).
3. **Use RS256** — set `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` (base64-encoded PEM) in your environment to enable asymmetric signing. The system detects these variables and switches from HS256 automatically.
4. **Configure API keys** — generate API keys using `generateApiKey()` from `src/middleware/auth.js`, hash them with `hashApiKey()`, and store the hash + role in the `users` DynamoDB table. Distribute raw keys to CI/CD pipelines or external integrations.

**Generating an API key programmatically:**
```js
const { generateApiKey, hashApiKey } = require('./src/middleware/auth');
const rawKey = generateApiKey(); // 64-char hex string — distribute this
const hash   = hashApiKey(rawKey); // store this in DynamoDB, not the raw key
console.log({ rawKey, hash });
```

---

## 5. Step-by-Step Usage Guide

### Step 1 — Confirm the Server is Running

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{ "status": "healthy" }
```

If you see `"status": "unhealthy"`, DynamoDB is not reachable. Check that `DYNAMODB_ENDPOINT` is set and DynamoDB Local is running.

---

### Step 2 — Send Your First Event

Replace `<TOKEN>` with the JWT from Step 6 of the Quick Start.

```bash
curl -X POST http://localhost:3000/events \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "api",
    "type": "error",
    "severity": "high",
    "title": "Payment failed",
    "description": "Stripe charge failed for customer cus_123",
    "metadata": {
      "amount": 1200,
      "currency": "usd",
      "customerId": "cus_123",
      "category": "payment"
    }
  }'
```

Expected response (`201 Created`):
```json
{
  "success": true,
  "data": {
    "id": "a1b2c3d4-...",
    "source": "api",
    "type": "error",
    "severity": "high",
    "title": "Payment failed",
    "description": "Stripe charge failed for customer cus_123",
    "metadata": { "amount": 1200, "currency": "usd", "customerId": "cus_123", "category": "payment" },
    "timestamp": "2026-04-12T10:15:00.000Z"
  }
}
```

**What happens next (automatically):**
- The rule engine evaluates the event. Because `type = "error"` and `metadata.category = "payment"`, rule `payment-failure` fires → severity is set to `high`, alert triggered.
- An alert record is written to `AlertsTable`.
- SNS publishes the alert.
- An HTML email is sent to `ALERT_EMAIL_TO` (if SMTP is configured).

---

### Step 3 — List All Events

```bash
curl http://localhost:3000/events \
  -H "Authorization: Bearer <TOKEN>"
```

Response:
```json
{
  "success": true,
  "data": {
    "events": [ { "id": "...", "type": "error", "severity": "high", ... } ],
    "nextKey": null
  }
}
```

**Filtering and pagination:**

```bash
# Filter by severity
curl "http://localhost:3000/events?severity=high" \
  -H "Authorization: Bearer <TOKEN>"

# Filter by source
curl "http://localhost:3000/events?source=api" \
  -H "Authorization: Bearer <TOKEN>"

# Pagination — pass nextKey from the previous response
curl "http://localhost:3000/events?limit=10&lastKey=<nextKey>" \
  -H "Authorization: Bearer <TOKEN>"
```

---

### Step 4 — Get a Single Event

```bash
curl "http://localhost:3000/events/<eventId>?timestamp=<ISO-timestamp>" \
  -H "Authorization: Bearer <TOKEN>"
```

> Note: DynamoDB uses a composite key of `id` + `timestamp`. You can get the timestamp from the list response.

---

### Step 5 — View Alerts

```bash
# All open alerts
curl "http://localhost:3000/alerts?status=open" \
  -H "Authorization: Bearer <TOKEN>"

# Acknowledge an alert (operators and admins)
curl -X PATCH http://localhost:3000/alerts/<alertId>/acknowledge \
  -H "Authorization: Bearer <TOKEN>"

# Resolve an alert (operators and admins)
curl -X PATCH http://localhost:3000/alerts/<alertId>/resolve \
  -H "Authorization: Bearer <TOKEN>"
```

Alert status lifecycle: `open` → `acknowledged` → `resolved`

---

### Step 6 — Delete an Event (Admin Only)

```bash
curl -X DELETE "http://localhost:3000/events/<eventId>?timestamp=<ISO-timestamp>" \
  -H "Authorization: Bearer <TOKEN>"
```

Returns: `{ "success": true, "data": { "deleted": true } }`

---

### Step 7 — Check Who You Are

```bash
curl http://localhost:3000/auth/me \
  -H "Authorization: Bearer <TOKEN>"
```

Response:
```json
{
  "success": true,
  "data": {
    "id": "user-uuid",
    "email": "admin@example.com",
    "role": "admin",
    "createdAt": "2026-04-12T10:00:00.000Z"
  }
}
```

---

## 6. Webhook Integration

Webhooks allow external services to push events directly into the system without any code changes on your side — just point the service at the right URL.

### Endpoint

```
POST /webhook/{source}
```

Supported sources: `github`, `stripe`, `datadog`, `generic`

### GitHub Integration

**Configure in GitHub:**
- Go to your repo → Settings → Webhooks → Add webhook
- Payload URL: `https://your-api.example.com/webhook/github`
- Content type: `application/json`
- Secret: your HMAC secret (set `GITHUB_WEBHOOK_SECRET` in your `.env`)
- Events: choose which events to send

**What gets captured:**

| GitHub Event | Mapped To | Default Severity |
|---|---|---|
| `push` to main/master | `info` type | `medium` |
| `push` to feature branch | `info` type | `low` |
| `workflow_run` failure | `error` type | `high` |
| `deployment_status` failure | `error` type | `high` |
| `pull_request` (any action) | `info` type | `low` |
| `issues` with `critical` label | `warning` type | `high` |
| `ping` (initial connection) | `info` type | `low` |

**Example — simulating a GitHub push webhook:**
```bash
curl -X POST http://localhost:3000/webhook/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-GitHub-Delivery: abc-123-delivery-uuid" \
  -H "X-Hub-Signature-256: sha256=<computed-hmac>" \
  -d '{
    "ref": "refs/heads/main",
    "repository": { "full_name": "myorg/myrepo" },
    "commits": [{ "id": "abc1234", "message": "Fix critical bug", "author": { "name": "dev" } }],
    "pusher": { "name": "dev" },
    "compare": "https://github.com/myorg/myrepo/compare/..."
  }'
```

---

### Stripe Integration

**Configure in Stripe Dashboard:**
- Dashboard → Developers → Webhooks → Add endpoint
- URL: `https://your-api.example.com/webhook/stripe`
- Events: `payment_intent.payment_failed`, `invoice.payment_failed`, `charge.dispute.created`, etc.

**What gets captured:**

| Stripe Event | Mapped Severity | Alert Triggered |
|---|---|---|
| `payment_intent.payment_failed` | `high` | Yes |
| `invoice.payment_failed` (attempt ≥ 3) | `critical` | Yes |
| `charge.dispute.created` (chargeback) | `high` | Yes |
| `radar.early_fraud_warning.created` | `critical` | Yes |
| `customer.subscription.deleted` | `high` | Yes |
| `payment_intent.succeeded` | `low` | No |

---

### Datadog Integration

Point Datadog monitor webhooks at:
```
POST /webhook/datadog
X-Webhook-Secret: your-shared-secret
```

Datadog alert statuses map to severities:

| Datadog Status | Mapped Severity |
|---|---|
| `alert` | `high` |
| `warning` / `no_data` | `medium` |
| `recovered` / `ok` / `resolved` | `low` |

---

### Generic Webhook

For any service that supports outgoing webhooks, use the `generic` source:

```bash
POST /webhook/generic
X-Webhook-Secret: your-shared-secret
Content-Type: application/json

{
  "type": "error",
  "severity": "high",
  "title": "Database replication lag detected",
  "description": "Replication lag exceeded 30 seconds on replica-2",
  "metadata": {
    "lagSeconds": 32,
    "replica": "replica-2"
  }
}
```

If `type` or `severity` are missing or invalid, the system defaults to `type: "info"` and `severity: "medium"` so events are never silently dropped.

---

## 7. Alert System

Alerts are created and dispatched automatically — no manual action required.

### When an Alert Is Created

An alert is created when **either** of these conditions is true:
1. A `POST /events` request delivers an event with `severity: "high"` or `severity: "critical"`.
2. The rule engine classifies an event as `high` or `critical` (even if the original `severity` field was lower).

### What Happens When an Alert Fires

```
1. Alert record written to AlertsTable (status: "open")
2. SNS publishes the alert message
3. alertDispatcher Lambda receives the SNS message
4. Dispatcher routes to configured channels:
   - Email  → HTML alert email via SMTP/SES
   - Slack  → JSON Block Kit message via Incoming Webhook
   - SMS    → SNS SMS or Twilio
5. AlertsTable updated with delivery status
```

### Email Alerts

Configure in `.env`:
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
ALERT_EMAIL_TO=ops-team@company.com
EMAIL_FROM=alerts@yourcompany.com
```

The email includes:
- Severity badge (color-coded: red for critical, orange for high)
- Event title, type, source, timestamp
- AI-generated summary and recommendation (if AI analysis ran)
- Root cause hypothesis
- Metadata key-value table
- Link to the dashboard

### SNS Alerts

Configure in `.env`:
```env
SNS_TOPIC_ARN=arn:aws:sns:us-east-1:123456789:CriticalAlerts
```

Any SNS subscriber (Lambda, SQS, HTTP endpoint, email) will receive the alert JSON automatically.

### Alert Lifecycle

```
open → acknowledged → resolved
```

- `open`: Alert was sent, no human action yet
- `acknowledged`: Operator confirmed they are investigating (`PATCH /alerts/:id/acknowledge`)
- `resolved`: Issue is fixed (`PATCH /alerts/:id/resolve`)

---

## 8. Rule Engine

Rules live in [src/config/rules.json](../src/config/rules.json). **No code changes** are needed to add, modify, or remove rules — edit the JSON file and restart (or redeploy).

### Built-In Rules (Priority Order)

| Priority | Rule ID | Condition | Action |
|---|---|---|---|
| 1 | `critical-event-type` | `type == "critical"` | severity=critical, alert=true |
| 2 | `high-error-rate` | `type == "error"` AND `metadata.count > 50` | severity=high, alert=true |
| 3 | `payment-failure` | `type == "error"` AND `metadata.category == "payment"` | severity=high, alert=true |
| 4 | `payment-failure-title` | `title contains "payment"` AND `type == "error"` | severity=high, alert=true |
| 5 | `api-high-latency` | `metadata.latencyMs > 5000` | severity=medium, alert=false |
| 6 | `signup-spike` | `metadata.signupSpike > 200` | severity=medium, alert=false |
| 7 | `info-event` | `type == "info"` | severity=low, alert=false |

**The first matching rule wins.** If no rule matches, default is `severity: "medium"`, `alert: false`.

### Adding a New Rule

Open [src/config/rules.json](../src/config/rules.json) and add an entry:

```json
{
  "id": "disk-space-critical",
  "description": "Alert when disk usage exceeds 90%",
  "priority": 2,
  "condition": {
    "field": "metadata.diskUsagePct",
    "operator": "greaterThan",
    "value": 90
  },
  "action": {
    "setSeverity": "critical",
    "triggerAlert": true
  }
}
```

**Supported operators:** `equals`, `contains`, `greaterThan`, `lessThan`, `regex`, `exists`

**Compound conditions:**
```json
{
  "field": "type",
  "operator": "equals",
  "value": "error",
  "and": {
    "field": "metadata.region",
    "operator": "equals",
    "value": "us-east-1"
  }
}
```

### Frequency Anomaly Detection

The rule engine also checks whether the current event volume for a given type is ≥ 3× the 24-hour baseline average. This is checked by `checkFrequencyAnomaly(event)` and is used in conjunction with rules for escalation.

---

## 9. AI Analysis

### How It Works

After an event is written to DynamoDB, a separate Lambda is triggered via DynamoDB Streams. It sends the event to OpenAI (`gpt-4o-mini`) and stores the result back on the event record.

**AI output fields:**
```json
{
  "summary": "Stripe charge failed due to insufficient funds. Customer cus_123 attempted a $12.00 USD charge that was declined by the issuing bank.",
  "severity": "high",
  "recommendation": "Contact the customer to update their payment method. If this is recurring, flag the account for review.",
  "rootCause": "Insufficient funds on the customer's card.",
  "confidence": 92
}
```

### What Gets Skipped

AI analysis is **skipped** when:
- `AI_ENABLED=false` in environment
- `OPENAI_API_KEY` is not set
- The event was already classified as `severity: "low"` by the rule engine
- The circuit breaker is open (5 consecutive failures → 5-minute cooldown)
- AI confidence < 50% (falls back to rule engine result)

When skipped, the event keeps its rule-engine severity and processing continues normally.

### Circuit Breaker

```
Consecutive AI failures:  0 1 2 3 4 → 5 (OPEN)
                                       ↓
                           AI disabled for 5 minutes
                                       ↓
                           5 minutes elapsed → trial call
                                       ↓
                           Success → CLOSED (counter reset)
                           Failure → stays OPEN for another 5 minutes
```

**Effect:** If OpenAI is down, the system continues operating with rule-based classification only. No operator intervention required.

### Cost Tracking

Every AI call records token usage and estimated USD cost to `MetricsTable`:
- Key: `ai_cost:YYYY-MM-DDTHH` (hourly)
- Key: `ai_tokens:YYYY-MM-DDTHH` (hourly)

For batch events of the same type+source, a single AI call analyzes the group — reducing token spend significantly.

### Configuring AI

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
AI_ENABLED=true
AI_MAX_RETRIES=3
AI_CIRCUIT_BREAKER_THRESHOLD=5
AI_CIRCUIT_BREAKER_TIMEOUT_MS=300000
AI_RATE_LIMIT_PER_MINUTE=100
```

---

## 10. Dashboard & Metrics APIs

All dashboard endpoints require a valid JWT or API key. Viewer role is sufficient for all read-only endpoints.

### List Events

```bash
GET /events
GET /events?severity=high
GET /events?source=webhook
GET /events?limit=50&lastKey=<cursor>
```

### Get Single Event

```bash
GET /events/:id?timestamp=<ISO-timestamp>
```

### List Alerts

```bash
GET /alerts
GET /alerts?status=open
GET /alerts?status=acknowledged
```

### System Health

```bash
GET /health
```
No auth required. Returns `{ "status": "healthy" }` or `{ "status": "unhealthy", "error": "..." }`.

> **Note:** Dashboard stat endpoints (`/dashboard/stats`, `/dashboard/trends`, `/metrics/cost`) are defined in the architecture but may require the full Serverless Framework deployment. When running locally with `node server.js`, check [src/handlers/routes/](../src/handlers/routes/) for available Express routes.

---

## 11. Common Errors & Fixes

### 401 — Missing or Invalid Token

```json
{ "success": false, "message": "Missing authentication credentials" }
{ "success": false, "message": "Invalid token" }
{ "success": false, "message": "Token has expired" }
```

**Fixes:**
- Make sure you are sending the header: `Authorization: Bearer <token>`
- Check that `JWT_SECRET` in your `.env` matches the secret used when the token was issued
- If the token expired, log in again via `POST /auth/login`
- Check the clock skew — `exp` in the token is Unix epoch seconds

---

### 403 — Insufficient Permissions

```json
{ "success": false, "message": "Insufficient permissions" }
```

**Fix:** The operation requires a higher role. For example, `POST /events` requires `operator` or `admin`. A `viewer` token will be rejected. Use a token with the correct role.

---

### 400 — Validation Failed

```json
{
  "success": false,
  "message": "Validation failed",
  "details": ["\"source\" is required", "\"type\" must be a string"]
}
```

**Fix:** Check the required fields. Every event must include at minimum:
- `source` (string, max 100 chars) — e.g. `"api"`, `"webhook"`, `"manual"`
- `type` (string, max 100 chars) — e.g. `"error"`, `"warning"`, `"info"`, `"critical"`

Optional fields: `severity`, `payload`, `metadata`, `ttl`

---

### 409 — Duplicate Registration

```json
{ "success": false, "message": "Email already registered" }
```

**Fix:** The email address already exists in the database. Use a different email or log in instead.

---

### 404 — Event Not Found

```json
{ "success": false, "message": "Event not found" }
```

**Fix:** You must provide both `id` and `timestamp` (from the original creation response) as query parameters. DynamoDB uses a composite key. Example:
```bash
GET /events/abc-123?timestamp=2026-04-12T10:15:00.000Z
```

---

### 429 — Rate Limited

```json
{ "success": false, "message": "Too many requests" }
```

**Fix:** You have exceeded the request limit for your IP or API key. Check the response headers:
- `X-RateLimit-Limit` — max requests per window
- `X-RateLimit-Remaining` — how many are left
- `X-RateLimit-Reset` — Unix timestamp when the window resets

Wait until `X-RateLimit-Reset` and retry.

---

### 500 — Internal Server Error

```json
{ "success": false, "message": "Internal server error" }
```

**Fix steps:**
1. Check server logs — errors are logged as structured JSON with `stack` and `path`
2. Most common causes:
   - DynamoDB is unreachable → verify `DYNAMODB_ENDPOINT` or AWS credentials
   - Missing required env var → check `src/config/index.js` for what is expected
   - Invalid AWS credentials → set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`

---

### 503 — Health Check Failed

```json
{ "status": "unhealthy", "error": "Connect ECONNREFUSED 127.0.0.1:8000" }
```

**Fix:** DynamoDB Local is not running. Start it:
```bash
docker run -p 8000:8000 amazon/dynamodb-local
```
Or in production, verify your AWS credentials and `AWS_REGION` are correct.

---

### ECONNREFUSED on DynamoDB

```
Error: connect ECONNREFUSED 127.0.0.1:8000
```

**Fix:**
```bash
# Set the local endpoint in .env
DYNAMODB_ENDPOINT=http://localhost:8000
# Then restart the server
```

---

### "Unsupported webhook source" Error

```json
{ "success": false, "message": "Unsupported webhook source: \"unknown\"" }
```

**Fix:** The `{source}` in the URL path must be one of: `github`, `stripe`, `datadog`, `generic`. Check the URL:
```
POST /webhook/github   ✓
POST /webhook/GitHub   ✗ (case-sensitive)
POST /webhook/gh       ✗ (not supported)
```

---

## 12. Important Limitations

Be aware of the following before building on this system:

### No Built-In Authentication UI
There is no login page, no sign-up form, and no session management UI. Authentication is handled entirely via API calls (`POST /auth/register` and `POST /auth/login`). If you need a UI, you must build it yourself or integrate a service like Supabase Auth or Auth0.

### No Self-Service Password Reset
There is no "forgot password" flow. Password resets require direct database intervention or a custom endpoint you add.

### API-First Architecture
Every interaction happens via HTTP requests. Non-developers cannot use this system without either a frontend UI (which you must build) or a tool like Postman/Insomnia.

### Requires AWS Configuration for Full Features
Alert delivery (SNS), webhook SQS queuing, and DynamoDB in production all require valid AWS credentials and infrastructure. Running purely locally with `node server.js` and DynamoDB Local gives you the core API but not the async event processing pipeline.

### Rate Limiter is In-Memory
The current rate limiter (`src/middleware/rateLimit.js`) uses a `Map` in the Node.js process. This resets on restart and does **not** share state across multiple server instances. For multi-instance production deployments, replace with a Redis-backed rate limiter.

### No Built-In User Management UI
There is no admin panel for managing users, revoking API keys, or viewing audit logs through a UI. All of this requires direct API calls or database access.

### AI Analysis Requires OpenAI API Key
If `OPENAI_API_KEY` is not set or `AI_ENABLED=false`, AI analysis is silently skipped. Events are still processed and classified by the rule engine, but no AI summaries or recommendations are generated.

### DynamoDB Tables Must Be Created Manually
The tables (`events`, `users`, `alerts`, `MetricsTable`) must exist before the application starts. Use [infrastructure/cloudformation/dynamodb.yml](../infrastructure/cloudformation/dynamodb.yml) or create them manually. The application does not auto-create tables.

---

## 13. Optional Enhancements

These are not currently implemented but are natural next steps:

### Add a Frontend Dashboard
Build a React or Next.js UI that calls the existing REST API. Recommended pages:
- Events list with filter/search
- Event detail with AI analysis display
- Alert inbox (open → acknowledge → resolve workflow)
- Stats charts using `/dashboard/stats` and `/dashboard/trends`

### Add Password Reset
Implement a `POST /auth/forgot-password` endpoint that sends a time-limited reset token via email, and a `POST /auth/reset-password` endpoint that validates the token and updates the hashed password.

### Add API Key Management UI
A `/admin/api-keys` route set (create, list, revoke) would let operators generate and manage keys without direct database access.

### Add Redis-Backed Rate Limiting
Replace the in-memory `Map` in [src/middleware/rateLimit.js](../src/middleware/rateLimit.js) with an `ioredis` client. This enables rate limiting to work correctly across multiple server instances and survive restarts.

### Add Slack Alert Channel
Create `src/services/slackService.js` with an Incoming Webhook call. Register it in `alertDispatcher.js`. Add `SLACK_WEBHOOK_URL` to `.env`. The rest of the pipeline already supports it.

### Add a Daily Digest
The `emailService.sendDigest()` function is already implemented and tested. Wire it to a scheduled Lambda (cron: `rate(1 day)`) that fetches the last 24 hours of events and sends the digest to `ALERT_EMAIL_TO`.

### Add Pagination to the Dashboard
The `/events` list endpoint already supports `limit` + `lastKey` cursor pagination. Build a frontend that pages through results for large event volumes.

### Add Multi-Tenancy
Add a `tenantId` field to the event schema and user model. Scope all DynamoDB queries with a `tenantId` filter. Use separate JWT claims to carry the tenant identifier. This allows the system to serve multiple organizations from a single deployment.

---

## Quick Reference — Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | App environment |
| `APP_PORT` | No | `3000` | HTTP server port |
| `JWT_SECRET` | Yes | `change_me` | Secret for HS256 JWT signing |
| `JWT_EXPIRES_IN` | No | `7d` | JWT token expiry |
| `AWS_REGION` | Yes | `us-east-1` | AWS region |
| `DYNAMODB_ENDPOINT` | Dev only | — | Local DynamoDB URL (e.g. `http://localhost:8000`) |
| `DYNAMODB_EVENTS_TABLE` | Yes | `events` | DynamoDB table name |
| `DYNAMODB_USERS_TABLE` | Yes | `users` | DynamoDB table name |
| `DYNAMODB_ALERTS_TABLE` | Yes | `alerts` | DynamoDB table name |
| `DYNAMODB_METRICS_TABLE` | No | `MetricsTable` | DynamoDB table name |
| `OPENAI_API_KEY` | No | — | OpenAI key (AI disabled if absent) |
| `AI_ENABLED` | No | `true` | Set to `false` to disable AI |
| `SNS_TOPIC_ARN` | No | — | SNS topic for alert fan-out |
| `SMTP_HOST` | No | — | SMTP server (email alerts) |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_USER` | No | — | SMTP username |
| `SMTP_PASS` | No | — | SMTP password |
| `ALERT_EMAIL_TO` | No | — | Alert recipient email |
| `RATE_LIMIT_MAX_REQUESTS` | No | `100` | Max requests per window per IP |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit window in milliseconds |
| `LOG_LEVEL` | No | `info` | Winston log level |

---

## Quick Reference — Event Object Schema

```json
{
  "source":      "api | webhook | manual",
  "type":        "error | warning | info | critical",
  "severity":    "low | medium | high | critical",
  "title":       "Human-readable title (max 200 chars)",
  "description": "Optional detail (max 2000 chars)",
  "metadata": {
    "anyKey": "anyValue"
  }
}
```

Fields added automatically by the server: `id` (UUID), `timestamp` (ISO 8601), `ttl` (30-day epoch).

---

*Generated: 2026-04-12 | System: Event Monitoring & Alert System | Stack: Node.js 20 · AWS Lambda · DynamoDB · SQS · SNS · OpenAI*

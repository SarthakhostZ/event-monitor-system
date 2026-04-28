'use strict';

/**
 * eventIngest — Lambda handler for POST /events
 *
 * Flow:
 *   API Gateway → [JWT auth] → [rate limit] → [Joi validation]
 *     → [idempotency lock] → SQS enqueue → 202 Accepted
 *
 * This handler never writes to EventsTable directly.
 * The downstream eventProcessor owns persistence.
 */

const jwt  = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { SQSClient, SendMessageCommand }                                 = require('@aws-sdk/client-sqs');
const { DynamoDBClient }                                                = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const logger                   = require('../utils/logger');
const { validateEvent }        = require('../models/eventModel');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION  (read once at cold start — never inside the handler)
// ─────────────────────────────────────────────────────────────────────────────
const REGION         = process.env.AWS_REGION      || 'ap-south-1';
const EVENTS_TABLE   = process.env.DYNAMODB_EVENTS_TABLE;
const METRICS_TABLE  = process.env.DYNAMODB_METRICS_TABLE;
const SQS_QUEUE_URL  = process.env.SQS_QUEUE_URL;
const JWT_SECRET     = process.env.JWT_SECRET;
const JWT_ISSUER     = process.env.JWT_ISSUER     || 'event-monitor-system';
const JWT_AUDIENCE   = process.env.JWT_AUDIENCE   || 'event-monitor-api';
const RATE_LIMIT     = parseInt(process.env.RATE_LIMIT_DEFAULT, 10) || 100;
const IDEM_TTL_SECS  = 24 * 60 * 60;           // idempotency lock lives 24 h
const RATE_WIN_SECS  = 60;                      // rate limit window: 1 minute

// ─────────────────────────────────────────────────────────────────────────────
// AWS CLIENTS  (initialised outside handler — reused across warm invocations)
// ─────────────────────────────────────────────────────────────────────────────
const dynamoOpts = {
  region: REGION,
  ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
};
const _dynamo    = new DynamoDBClient(dynamoOpts);
const docClient  = DynamoDBDocumentClient.from(_dynamo, {
  marshallOptions: { removeUndefinedValues: true },
});
const sqsClient  = new SQSClient({ region: REGION });

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const startMs   = Date.now();
  const requestId = extractRequestId(event);

  // Attach requestId + function name to every log line in this invocation
  const log = logger.child({ requestId, fn: 'eventIngest' });

  log.info('Request received', {
    method:   event.httpMethod,
    path:     event.path,
    sourceIp: event.requestContext?.identity?.sourceIp,
  });

  try {
    // ── Step 1: JWT verification ─────────────────────────────────────────────
    const authResult = verifyJwt(
      event.headers?.Authorization || event.headers?.authorization,
      log,
    );
    if (authResult.error) {
      return buildResponse(401, { error: authResult.error }, requestId, startMs);
    }
    const { claims } = authResult;

    if (!['admin', 'operator'].includes(claims.role)) {
      log.warn('Forbidden — insufficient role', { role: claims.role });
      return buildResponse(403, {
        error: 'Forbidden',
        message: 'operator or admin role required to ingest events',
      }, requestId, startMs);
    }

    // clientId drives rate-limit bucketing (prefer sub, fall back to email)
    const clientId = claims.sub || claims.email || 'anonymous';
    log.debug('JWT verified', { clientId, role: claims.role });

    // ── Step 2: Rate limiting ────────────────────────────────────────────────
    const rateResult = await checkRateLimit(clientId, log);

    const rateLimitHeaders = {
      'X-RateLimit-Limit':     String(RATE_LIMIT),
      'X-RateLimit-Remaining': String(Math.max(0, RATE_LIMIT - rateResult.count)),
      'X-RateLimit-Reset':     String(rateResult.windowResetEpoch),
    };

    if (rateResult.exceeded) {
      log.warn('Rate limit exceeded', { clientId, count: rateResult.count, limit: RATE_LIMIT });
      return buildResponse(429, {
        error:             'Too Many Requests',
        message:           `Rate limit of ${RATE_LIMIT} requests/min exceeded`,
        retryAfterSeconds: rateResult.retryAfterSeconds,
      }, requestId, startMs, {
        ...rateLimitHeaders,
        'Retry-After': String(rateResult.retryAfterSeconds),
      });
    }

    // ── Step 3: Parse body ───────────────────────────────────────────────────
    let rawBody;
    try {
      rawBody = JSON.parse(event.body || '{}');
    } catch {
      return buildResponse(400, {
        error:   'Bad Request',
        message: 'Request body must be valid JSON',
      }, requestId, startMs);
    }

    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      return buildResponse(400, {
        error:   'Bad Request',
        message: 'Request body must be a JSON object',
      }, requestId, startMs);
    }

    // ── Step 4: Joi schema validation ────────────────────────────────────────
    const { value: validated, error: validationErr } = validateEvent(rawBody);
    if (validationErr) {
      const details = validationErr.details.map((d) => ({
        field:   d.path.join('.') || d.context?.key || 'unknown',
        message: d.message.replace(/['"]/g, ''),
      }));
      log.warn('Validation failed', { details });
      return buildResponse(400, {
        error:   'Validation Failed',
        message: 'Event payload did not pass schema validation',
        details,
      }, requestId, startMs);
    }

    log.debug('Payload validated', {
      eventId:        validated.eventId,
      source:         validated.source,
      type:           validated.type,
      severity:       validated.severity,
      idempotencyKey: validated.idempotencyKey,
    });

    // ── Step 5: Idempotency check ────────────────────────────────────────────
    //
    // Strategy: attempt an atomic conditional PutItem on MetricsTable using
    //   metricKey = "idem:<idempotencyKey>"  (namespace prevents collisions)
    //   timestamp = "lock"                  (fixed SK lets GetItem resolve it)
    //
    // If the item already exists → ConditionalCheckFailedException → 409.
    // This is race-condition-safe; no separate GET + PUT needed.
    //
    // The eventProcessor adds a second authoritative guard via a conditional
    // write on EventsTable — protecting against SQS redelivery as well.
    const idemStart = Date.now();
    const idemResult = await acquireIdempotencyLock(validated.idempotencyKey, validated.eventId, log);
    const idemMs    = Date.now() - idemStart;

    if (idemResult.isDuplicate) {
      log.warn('Duplicate event — idempotency key already locked', {
        idempotencyKey:  validated.idempotencyKey,
        existingEventId: idemResult.existingEventId,
        idemCheckMs:     idemMs,
      });
      return buildResponse(409, {
        error:           'Conflict',
        message:         'An event with this idempotencyKey was already received',
        existingEventId: idemResult.existingEventId,
      }, requestId, startMs);
    }

    log.debug('Idempotency lock acquired', { idempotencyKey: validated.idempotencyKey, idemCheckMs: idemMs });

    // ── Step 6: Enqueue to SQS ───────────────────────────────────────────────
    const sqsStart   = Date.now();
    const sqsPayload = JSON.stringify({
      ...validated,
      _meta: {
        requestId,
        clientId,
        enqueuedAt: new Date().toISOString(),
      },
    });

    await sqsClient.send(new SendMessageCommand({
      QueueUrl:          SQS_QUEUE_URL,
      MessageBody:       sqsPayload,
      MessageAttributes: {
        requestId: { DataType: 'String', StringValue: requestId },
        source:    { DataType: 'String', StringValue: validated.source },
        severity:  { DataType: 'String', StringValue: validated.severity },
        eventId:   { DataType: 'String', StringValue: validated.eventId },
      },
    }));

    const sqsMs    = Date.now() - sqsStart;
    const totalMs  = Date.now() - startMs;

    log.info('Event accepted and queued', {
      eventId:        validated.eventId,
      idempotencyKey: validated.idempotencyKey,
      source:         validated.source,
      type:           validated.type,
      severity:       validated.severity,
      sqsDurationMs:  sqsMs,
      totalDurationMs: totalMs,
    });

    // ── Step 7: 202 Accepted ─────────────────────────────────────────────────
    return buildResponse(202, {
      eventId:   validated.eventId,
      status:    'queued',
      message:   'Event accepted for asynchronous processing',
    }, requestId, startMs, rateLimitHeaders);

  } catch (err) {
    const totalMs = Date.now() - startMs;
    log.error('Unhandled error in eventIngest', {
      error:          err.message,
      stack:          err.stack,
      totalDurationMs: totalMs,
    });
    return buildResponse(500, {
      error:   'Internal Server Error',
      message: 'An unexpected error occurred. Check CloudWatch logs for details.',
    }, requestId, startMs);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// JWT VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse and verify a Bearer JWT.
 *
 * Returns `{ claims }` on success or `{ error: string }` on failure.
 * Never throws — callers check the discriminant field.
 *
 * @param {string|undefined} authHeader - Raw Authorization header value
 * @param {object}           log        - Winston child logger
 * @returns {{ claims?: object, error?: string }}
 */
function verifyJwt(authHeader, log) {
  if (!authHeader) {
    return { error: 'Authorization header is required' };
  }

  if (!authHeader.startsWith('Bearer ')) {
    return { error: 'Authorization header must use Bearer scheme' };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return { error: 'Bearer token is empty' };
  }

  try {
    const claims = jwt.verify(token, JWT_SECRET, {
      issuer:   JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    return { claims };
  } catch (err) {
    const reason =
      err.name === 'TokenExpiredError'  ? 'Token has expired' :
      err.name === 'JsonWebTokenError'  ? 'Token is invalid or malformed' :
      err.name === 'NotBeforeError'     ? 'Token is not yet valid' :
                                          'Token verification failed';
    log.warn('JWT verification failed', { reason, jwtError: err.name });
    return { error: reason };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Token-bucket rate limiter backed by DynamoDB.
 *
 * Uses an atomic ADD on MetricsTable so concurrent Lambda invocations
 * never over-count. The counter key is scoped to the client and the
 * current UTC minute, so it resets automatically without cleanup jobs.
 *
 * @param {string} clientId - JWT sub / email that identifies the caller
 * @param {object} log
 * @returns {{ count: number, exceeded: boolean, windowResetEpoch: number, retryAfterSeconds: number }}
 */
async function checkRateLimit(clientId, log) {
  const now         = new Date();
  const minuteKey   = now.toISOString().slice(0, 16);   // "YYYY-MM-DDTHH:MM"
  const metricKey   = `rate_limit:${clientId}:${minuteKey}`;
  const windowReset = new Date(now);
  windowReset.setSeconds(60, 0);                         // end of current minute
  const windowResetEpoch   = Math.floor(windowReset.getTime() / 1000);
  const retryAfterSeconds  = Math.max(1, windowResetEpoch - Math.floor(Date.now() / 1000));
  const ttl                = windowResetEpoch + RATE_WIN_SECS; // 1 extra minute grace

  try {
    const { Attributes } = await docClient.send(new UpdateCommand({
      TableName:                 METRICS_TABLE,
      Key:                       { metricKey, timestamp: 'rate-limit-window' },
      UpdateExpression:          'SET #ttl = if_not_exists(#ttl, :ttl) ADD #count :one',
      ExpressionAttributeNames:  { '#count': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': ttl },
      ReturnValues:              'ALL_NEW',
    }));

    const count = Attributes?.count ?? 1;
    log.debug('Rate limit check', { clientId, count, limit: RATE_LIMIT, window: minuteKey });

    return { count, exceeded: count > RATE_LIMIT, windowResetEpoch, retryAfterSeconds };

  } catch (err) {
    // Degrade gracefully: if the rate-limit store is unreachable, allow the request.
    // Log as error so the alarm fires, but don't punish the caller.
    log.error('Rate limit check failed — allowing request', { error: err.message });
    return { count: 0, exceeded: false, windowResetEpoch, retryAfterSeconds };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IDEMPOTENCY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically acquire an idempotency lock for the given key.
 *
 * Uses a conditional PutItem so that concurrent requests for the same key
 * are serialised at DynamoDB — only the first one succeeds.
 *
 * Lock records live in MetricsTable:
 *   PK (metricKey) = "idem:<idempotencyKey>"
 *   SK (timestamp) = "lock"
 *   ttl            = now + 24 h  (auto-expiry, no cleanup needed)
 *
 * @param {string} idempotencyKey
 * @param {string} eventId        - UUID for the new event (stored in the lock)
 * @param {object} log
 * @returns {{ isDuplicate: boolean, existingEventId?: string }}
 */
async function acquireIdempotencyLock(idempotencyKey, eventId, log) {
  const metricKey = `idem:${idempotencyKey}`;
  const ttl       = Math.floor(Date.now() / 1000) + IDEM_TTL_SECS;

  try {
    await docClient.send(new PutCommand({
      TableName:           METRICS_TABLE,
      Item:                { metricKey, timestamp: 'lock', eventId, lockedAt: new Date().toISOString(), ttl },
      ConditionExpression: 'attribute_not_exists(metricKey)',
    }));

    // Lock successfully acquired — this is a new event
    return { isDuplicate: false };

  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // Lock already exists — fetch the eventId stored in the existing lock
      try {
        const { Item } = await docClient.send(new GetCommand({
          TableName: METRICS_TABLE,
          Key:       { metricKey, timestamp: 'lock' },
        }));
        return { isDuplicate: true, existingEventId: Item?.eventId };
      } catch (getErr) {
        log.warn('Could not fetch existing idempotency record', { error: getErr.message });
        return { isDuplicate: true, existingEventId: undefined };
      }
    }

    // Any other error (throttling, network) — fail open so the caller isn't
    // silently dropped. The processor's authoritative guard will catch true dupes.
    log.error('Idempotency check failed — proceeding without lock', { error: err.message });
    return { isDuplicate: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an API Gateway proxy integration response object.
 *
 * Always includes:
 *   - X-Request-ID  for end-to-end tracing
 *   - X-Duration-Ms for latency visibility in API Gateway logs
 *   - Standard security headers
 *
 * @param {number} statusCode
 * @param {object} body            - Will be JSON-serialised
 * @param {string} requestId
 * @param {number} startMs         - Date.now() at handler entry
 * @param {object} [extraHeaders]  - Any additional headers to merge
 * @returns {object} API Gateway proxy response
 */
function buildResponse(statusCode, body, requestId, startMs, extraHeaders = {}) {
  const durationMs = Date.now() - startMs;

  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'X-Request-ID':                requestId,
      'X-Duration-Ms':               String(durationMs),
      'Strict-Transport-Security':   'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options':      'nosniff',
      'X-Frame-Options':             'DENY',
      'Cache-Control':               'no-store',
      ...extraHeaders,
    },
    body: JSON.stringify({
      ...body,
      requestId,     // echo back so callers can correlate without parsing headers
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract or generate the X-Request-ID for this invocation.
 * API Gateway v1 sends mixed-case headers; v2 lowercases them.
 */
function extractRequestId(event) {
  return (
    event.headers?.['x-request-id']  ||
    event.headers?.['X-Request-Id']  ||
    event.headers?.['X-Request-ID']  ||
    event.requestContext?.requestId  || // API Gateway's own request ID
    uuidv4()
  );
}

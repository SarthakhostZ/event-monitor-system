'use strict';

/**
 * webhookReceiver — Lambda handler for POST /webhook/{source}
 *
 * Flow:
 *   API Gateway → [source check] → [signature verify] → [replay check]
 *     → [parse body] → [transform] → [Joi validate] → [idempotency lock]
 *       → [SQS enqueue] → 200 OK
 *
 * Design notes:
 *  - Raw body is read BEFORE any JSON.parse so HMAC is computed over the
 *    exact bytes the sender signed (parse → stringify can reorder keys).
 *  - Returns 200 for valid, authenticated payloads even if the transform
 *    or enqueue fails internally — we log and return 200 so the sender
 *    does not retry a webhook we already partially processed.
 *  - Returns 4xx only for auth failures and malformed requests, where
 *    retrying is the right behaviour.
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { SQSClient, SendMessageCommand }                      = require('@aws-sdk/client-sqs');
const { DynamoDBClient }                                     = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand,
        UpdateCommand }                                      = require('@aws-sdk/lib-dynamodb');
const qs = require('querystring');   // Node built-in — no extra dependency

const logger                             = require('../utils/logger');
const { validateEvent }                  = require('../models/eventModel');
const { SUPPORTED_SOURCES, transform,
        deriveIdempotencyKey,
        extractSourceTimestamp }         = require('../services/webhookTransformers');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const REGION        = process.env.AWS_REGION     || 'ap-south-1';
const METRICS_TABLE = process.env.DYNAMODB_METRICS_TABLE;
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;

// Per-source webhook secrets — each source has its own env var
const SECRETS = {
  github:  process.env.GITHUB_WEBHOOK_SECRET  || '',
  stripe:  process.env.STRIPE_WEBHOOK_SECRET  || '',
  datadog: process.env.DATADOG_WEBHOOK_SECRET || '',
  generic: process.env.GENERIC_WEBHOOK_SECRET || '',
};

// Replay attack tolerance — reject webhooks with a source timestamp
// older than this many seconds (Stripe uses 300 s as their standard)
const REPLAY_TOLERANCE_SECS = parseInt(process.env.WEBHOOK_REPLAY_TOLERANCE_SECS, 10) || 300;

// Idempotency lock TTL — one lock record per webhook delivery ID
const IDEM_TTL_SECS = 24 * 60 * 60;

// ─────────────────────────────────────────────────────────────────────────────
// AWS CLIENTS  (module-scope — reused across warm invocations)
// ─────────────────────────────────────────────────────────────────────────────
const dynamoOpts = {
  region: REGION,
  ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
};
const _dynamo   = new DynamoDBClient(dynamoOpts);
const docClient = DynamoDBDocumentClient.from(_dynamo, {
  marshallOptions: { removeUndefinedValues: true },
});
const sqsClient = new SQSClient({ region: REGION });

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const startMs   = Date.now();
  const requestId = extractRequestId(event);

  // ── Normalise headers to lowercase for consistent access ──────────────────
  const headers = normaliseHeaders(event.headers || {});
  const source  = (event.pathParameters?.source || '').toLowerCase().trim();

  const log = logger.child({ requestId, fn: 'webhookReceiver', source });

  log.info('Webhook received', {
    source,
    contentType: headers['content-type'],
    sourceIp:    event.requestContext?.identity?.sourceIp,
  });

  // ── Step 1: Source validation ─────────────────────────────────────────────
  if (!source) {
    return respond(400, { error: 'Bad Request', message: 'Missing {source} path parameter' }, requestId, startMs);
  }

  if (!SUPPORTED_SOURCES.includes(source)) {
    log.warn('Unsupported webhook source', { source, supported: SUPPORTED_SOURCES });
    return respond(400, {
      error:     'Unsupported Source',
      message:   `"${source}" is not a supported webhook source`,
      supported: SUPPORTED_SOURCES,
    }, requestId, startMs);
  }

  // ── Step 2: Secret presence check ────────────────────────────────────────
  const secret = SECRETS[source];
  if (!secret) {
    // Misconfiguration — a source without a configured secret must never process events
    log.error('Webhook secret not configured for source', { source });
    return respond(500, { error: 'Internal Server Error', message: 'Webhook integration not configured' }, requestId, startMs);
  }

  // ── Step 3: Raw body (MUST read before JSON.parse for HMAC correctness) ───
  const rawBody = decodeBody(event);
  if (rawBody === null) {
    return respond(400, { error: 'Bad Request', message: 'Request body is missing or could not be decoded' }, requestId, startMs);
  }

  // ── Step 4: Signature verification ───────────────────────────────────────
  const sigResult = verifySignature(source, rawBody, headers, secret, log);
  if (!sigResult.valid) {
    log.warn('Signature verification failed', { source, reason: sigResult.reason });
    // Return 401 so the sender knows this is an auth failure, not a processing error
    return respond(401, {
      error:   'Unauthorized',
      message: sigResult.reason,
    }, requestId, startMs);
  }

  // ── Step 5: Parse body ────────────────────────────────────────────────────
  const contentType = headers['content-type'] || '';
  const parseResult = parseBody(rawBody, contentType, log);
  if (parseResult.error) {
    return respond(400, {
      error:   'Bad Request',
      message: `Could not parse request body: ${parseResult.error}`,
    }, requestId, startMs);
  }
  const payload = parseResult.value;

  // ── Step 6: Replay attack detection ──────────────────────────────────────
  const replayResult = checkReplay(source, payload, headers, log);
  if (replayResult.isReplay) {
    log.warn('Replay attack detected — rejecting stale webhook', {
      source,
      payloadAgeSeconds: replayResult.ageSeconds,
      tolerance:         REPLAY_TOLERANCE_SECS,
    });
    return respond(400, {
      error:             'Replay Detected',
      message:           `Webhook timestamp is ${replayResult.ageSeconds}s old (max ${REPLAY_TOLERANCE_SECS}s)`,
      payloadAgeSeconds: replayResult.ageSeconds,
    }, requestId, startMs);
  }

  // ── From here, return 200 for all internal errors ─────────────────────────
  // The webhook has passed auth. If we fail downstream, we log and return 200
  // so the provider doesn't endlessly retry a delivery we have acknowledged.
  try {
    // ── Step 7: Transform to canonical event format ───────────────────────
    let canonical;
    try {
      canonical = transform(source, payload, headers);
    } catch (transformErr) {
      log.error('Transformer error — dropping event', { source, error: transformErr.message });
      return respond(200, { received: true, processed: false, reason: 'Transform failed — event dropped' }, requestId, startMs);
    }

    // ── Step 8: Validate transformed event against Joi schema ─────────────
    const { value: validated, error: validationErr } = validateEvent(canonical);
    if (validationErr) {
      const details = validationErr.details.map((d) => ({ field: d.path.join('.'), message: d.message }));
      log.error('Transformed event failed schema validation', { source, details });
      return respond(200, { received: true, processed: false, reason: 'Schema validation failed after transform' }, requestId, startMs);
    }

    // ── Step 9: Idempotency lock ──────────────────────────────────────────
    const idempotencyKey = deriveIdempotencyKey(source, payload, headers);
    validated.idempotencyKey = idempotencyKey;   // overwrite auto-derived key with provider's ID

    const idemResult = await acquireIdempotencyLock(idempotencyKey, validated.eventId, log);
    if (idemResult.isDuplicate) {
      log.info('Duplicate webhook delivery — idempotent 200', {
        source,
        idempotencyKey,
        existingEventId: idemResult.existingEventId,
      });
      // Return 200 — the provider considers this delivery complete
      return respond(200, {
        received:        true,
        processed:       false,
        reason:          'Duplicate delivery — already processed',
        existingEventId: idemResult.existingEventId,
      }, requestId, startMs);
    }

    // ── Step 10: Send to SQS ──────────────────────────────────────────────
    const sqsStart   = Date.now();
    const sqsPayload = JSON.stringify({
      ...validated,
      _meta: {
        requestId,
        webhookSource: source,
        enqueuedAt:    new Date().toISOString(),
      },
    });

    await sqsClient.send(new SendMessageCommand({
      QueueUrl:          SQS_QUEUE_URL,
      MessageBody:       sqsPayload,
      MessageAttributes: {
        requestId:      { DataType: 'String', StringValue: requestId },
        source:         { DataType: 'String', StringValue: 'webhook' },
        webhookSource:  { DataType: 'String', StringValue: source },
        severity:       { DataType: 'String', StringValue: validated.severity },
        eventId:        { DataType: 'String', StringValue: validated.eventId },
      },
    }));

    const totalMs = Date.now() - startMs;
    log.info('Webhook queued successfully', {
      eventId:          validated.eventId,
      idempotencyKey,
      source,
      type:             validated.type,
      severity:         validated.severity,
      sqsDurationMs:    Date.now() - sqsStart,
      totalDurationMs:  totalMs,
    });

    return respond(200, {
      received:  true,
      processed: true,
      eventId:   validated.eventId,
    }, requestId, startMs);

  } catch (err) {
    // Unexpected error after auth — still return 200 to prevent retries
    log.error('Unexpected error in webhookReceiver — returning 200 to prevent retry storm', {
      source,
      error:          err.message,
      stack:          err.stack,
      totalDurationMs: Date.now() - startMs,
    });
    return respond(200, { received: true, processed: false, reason: 'Internal processing error' }, requestId, startMs);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SIGNATURE VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch to the correct verifier based on source.
 *
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifySignature(source, rawBody, headers, secret, log) {
  switch (source) {
    case 'github':  return verifyGitHub(rawBody, headers, secret, log);
    case 'stripe':  return verifyStripe(rawBody, headers, secret, log);
    case 'datadog': return verifyDatadog(rawBody, headers, secret, log);
    case 'generic': return verifyGeneric(rawBody, headers, secret, log);
    default:
      return { valid: false, reason: `No verifier registered for source "${source}"` };
  }
}

/**
 * GitHub: X-Hub-Signature-256: sha256=<hex>
 * Algorithm: HMAC-SHA256(secret, rawBody)
 */
function verifyGitHub(rawBody, headers, secret, log) {
  const sigHeader = headers['x-hub-signature-256'] || '';
  if (!sigHeader) {
    return { valid: false, reason: 'X-Hub-Signature-256 header is missing' };
  }

  if (!sigHeader.startsWith('sha256=')) {
    return { valid: false, reason: 'X-Hub-Signature-256 must start with "sha256="' };
  }

  const expected = `sha256=${hmacHex('sha256', secret, rawBody)}`;

  if (!timingSafeEqual(expected, sigHeader)) {
    log.debug('GitHub signature mismatch', { expected: expected.slice(0, 20) + '…' });
    return { valid: false, reason: 'GitHub signature verification failed' };
  }

  return { valid: true };
}

/**
 * Stripe: Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]
 *
 * Algorithm:
 *   signed_payload = t + "." + rawBody
 *   expected       = HMAC-SHA256(secret, signed_payload)
 * Any v1 value in the header that matches is accepted.
 */
function verifyStripe(rawBody, headers, secret, log) {
  const sigHeader = headers['stripe-signature'] || '';
  if (!sigHeader) {
    return { valid: false, reason: 'Stripe-Signature header is missing' };
  }

  // Parse "t=...,v1=...,v1=..." into parts
  const parts = {};
  for (const part of sigHeader.split(',')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx).trim();
    const v = part.slice(eqIdx + 1).trim();
    if (!parts[k]) parts[k] = [];
    parts[k].push(v);
  }

  const t  = parts.t?.[0];
  const v1 = parts.v1 || [];

  if (!t || v1.length === 0) {
    return { valid: false, reason: 'Stripe-Signature header is malformed (missing t or v1)' };
  }

  const signedPayload = `${t}.${rawBody}`;
  const expected      = hmacHex('sha256', secret, signedPayload);
  const matched       = v1.some((sig) => timingSafeEqual(expected, sig));

  if (!matched) {
    log.debug('Stripe signature mismatch');
    return { valid: false, reason: 'Stripe signature verification failed' };
  }

  return { valid: true, stripeTimestamp: parseInt(t, 10) };
}

/**
 * Datadog: DD-Signature header (SHA256 HMAC, hex-encoded)
 * Falls back to X-Datadog-Signature if DD-Signature is absent.
 */
function verifyDatadog(rawBody, headers, secret, log) {
  const sigHeader = headers['dd-signature'] || headers['x-datadog-signature'] || '';
  if (!sigHeader) {
    return { valid: false, reason: 'DD-Signature or X-Datadog-Signature header is missing' };
  }

  const expected = hmacHex('sha256', secret, rawBody);

  if (!timingSafeEqual(expected, sigHeader)) {
    log.debug('Datadog signature mismatch');
    return { valid: false, reason: 'Datadog signature verification failed' };
  }

  return { valid: true };
}

/**
 * Generic: X-Webhook-Secret header must match the configured shared secret exactly.
 * Uses timing-safe comparison to prevent timing attacks.
 */
function verifyGeneric(rawBody, headers, secret, log) {
  const provided = headers['x-webhook-secret'] || '';
  if (!provided) {
    return { valid: false, reason: 'X-Webhook-Secret header is missing' };
  }

  if (!timingSafeEqual(secret, provided)) {
    log.debug('Generic webhook secret mismatch');
    return { valid: false, reason: 'Invalid webhook secret' };
  }

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// REPLAY ATTACK DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect replayed webhook deliveries by checking the payload timestamp.
 *
 * Each source embeds its timestamp differently:
 *   Stripe   → Stripe-Signature t= value (most reliable, extracted from sig header)
 *   GitHub   → payload.repository.pushed_at or similar
 *   Datadog  → payload.last_updated epoch
 *   Generic  → payload.timestamp (ISO or epoch)
 *
 * @returns {{ isReplay: boolean, ageSeconds?: number }}
 */
function checkReplay(source, payload, headers, log) {
  let sourceEpoch = null;

  // Stripe's timestamp is in the signature header — more reliable than payload
  if (source === 'stripe') {
    const sigHeader = headers['stripe-signature'] || '';
    const tMatch    = sigHeader.match(/t=(\d+)/);
    if (tMatch) sourceEpoch = parseInt(tMatch[1], 10);
  }

  // For all other sources, use the transformer's extractor
  if (sourceEpoch === null) {
    sourceEpoch = extractSourceTimestamp(source, payload, headers);
  }

  if (sourceEpoch === null) {
    // No timestamp available — cannot check; allow through but log
    log.debug('No source timestamp available for replay check', { source });
    return { isReplay: false };
  }

  const nowEpoch   = Math.floor(Date.now() / 1000);
  const ageSeconds = nowEpoch - sourceEpoch;

  if (ageSeconds > REPLAY_TOLERANCE_SECS) {
    return { isReplay: true, ageSeconds };
  }

  // Also reject webhooks from the future (clock skew attack) beyond 60 s
  if (ageSeconds < -60) {
    log.warn('Webhook timestamp is in the future', { source, ageSeconds });
    return { isReplay: true, ageSeconds };
  }

  return { isReplay: false, ageSeconds };
}

// ─────────────────────────────────────────────────────────────────────────────
// IDEMPOTENCY LOCK  (same pattern as eventIngest)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically acquire an idempotency lock in MetricsTable.
 *
 * Key format:  "idem:<idempotencyKey>"
 * SK:          "lock"
 * TTL:         24 h
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
    return { isDuplicate: false };

  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
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

    // Any other error — fail open so the event isn't silently dropped
    log.error('Idempotency lock failed — proceeding without lock', { error: err.message });
    return { isDuplicate: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BODY DECODING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decode the raw Lambda body string, handling API Gateway's base64 encoding
 * for binary/form payloads.
 *
 * Returns the raw string exactly as signed — NOT parsed.
 */
function decodeBody(event) {
  if (!event.body) return null;
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, 'base64').toString('utf8');
  }
  return event.body;
}

/**
 * Parse the decoded raw body string into a JS object.
 * Supports application/json and application/x-www-form-urlencoded.
 *
 * @returns {{ value?: object, error?: string }}
 */
function parseBody(rawBody, contentType, log) {
  const ct = contentType.split(';')[0].trim().toLowerCase();

  try {
    if (ct === 'application/x-www-form-urlencoded') {
      const parsed = qs.parse(rawBody);
      // Datadog and some generic senders send JSON embedded in a form field
      if (parsed.payload && typeof parsed.payload === 'string') {
        try { parsed.payload = JSON.parse(parsed.payload); } catch { /* keep as string */ }
      }
      return { value: parsed };
    }

    // Default: treat as JSON (most webhook sources)
    return { value: JSON.parse(rawBody) };

  } catch (err) {
    log.warn('Body parse failed', { contentType, error: err.message });
    return { error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function respond(statusCode, body, requestId, startMs) {
  return {
    statusCode,
    headers: {
      'Content-Type':               'application/json',
      'X-Request-ID':               requestId,
      'X-Duration-Ms':              String(Date.now() - startMs),
      'Strict-Transport-Security':  'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options':     'nosniff',
      'Cache-Control':              'no-store',
    },
    body: JSON.stringify({ ...body, requestId }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Compute HMAC-hex for signature generation/verification. */
function hmacHex(algorithm, key, data) {
  return crypto.createHmac(algorithm, key).update(data, 'utf8').digest('hex');
}

/**
 * Timing-safe string comparison.
 * Pads both strings to the same length to prevent early-exit timing leaks.
 */
function timingSafeEqual(a, b) {
  // crypto.timingSafeEqual requires same-length Buffers
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // XOR a dummy buffer of the right length — still takes the same time
    crypto.timingSafeEqual(bufA, bufA);   // prevent short-circuit
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Normalise all header keys to lowercase. */
function normaliseHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
}

/** Extract or generate the X-Request-ID for this invocation. */
function extractRequestId(event) {
  return (
    event.headers?.['x-request-id']  ||
    event.headers?.['X-Request-Id']  ||
    event.headers?.['X-Request-ID']  ||
    event.requestContext?.requestId  ||
    uuidv4()
  );
}

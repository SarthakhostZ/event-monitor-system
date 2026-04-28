'use strict';

/**
 * DynamoDB-backed token-bucket rate limiter.
 *
 * Algorithm — sliding fixed window with burst allowance:
 *   Each (clientId, endpointKey, windowStart) triple maps to one DynamoDB item.
 *   DynamoDB's atomic ADD increments a counter per request.  The post-increment
 *   value is compared against the limit + burst ceiling; no optimistic-locking
 *   retries are needed because ADD is natively atomic.
 *
 * Fail-open: if DynamoDB is unreachable the request is allowed through and the
 *   error is logged — a temporary DB outage should not take down the API.
 *
 * Table layout (MetricsTable):
 *   PK  metricKey  →  "rl:{clientId}:{endpointKey}"
 *   SK  timestamp  →  window-start ISO string
 *   Attrs: count (N), ttl (N, epoch seconds, auto-expire after 2 windows)
 */

const { DynamoDBClient }         = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient,
        UpdateCommand }           = require('@aws-sdk/lib-dynamodb');
const config                     = require('../config');
const logger                     = require('../utils/logger');
const { error: sendError }       = require('../utils/response');

// ─── DynamoDB client (module-scope, reused across warm invocations) ───────────
const _dynamo = new DynamoDBClient({
  region: config.aws.region,
  ...(config.dynamodb.endpoint && { endpoint: config.dynamodb.endpoint }),
});
const docClient = DynamoDBDocumentClient.from(_dynamo, {
  marshallOptions: { removeUndefinedValues: true },
});

const RATE_TABLE    = config.dynamodb.metricsTable;
const WINDOW_MS     = 60_000;   // 1-minute sliding window

// ─── Per-endpoint rate limit profiles ────────────────────────────────────────
// `limit`  = sustained requests per window
// `burst`  = extra requests allowed above limit before hard-reject
//
// Matching is prefix-based on  "<METHOD> <path prefix>".
// Order matters — first match wins.
const ENDPOINT_PROFILES = [
  { match: (m, p) => m === 'POST' && p.startsWith('/webhook'),    limit: 500, burst: 100 },
  { match: (m, p) => m === 'POST' && isEventsPath(p),             limit: 100, burst: 20  },
  { match: (m, p) => m === 'GET'  && isDashboardPath(p),          limit: 60,  burst: 10  },
  { match: (m, p) => m === 'GET'  && isEventsPath(p),             limit: 200, burst: 40  },
];
const DEFAULT_PROFILE = { limit: 100, burst: 20 };

function isEventsPath(p)    { return p === '/events' || p.startsWith('/events/') || p.includes('/events'); }
function isDashboardPath(p) { return p.startsWith('/dashboard') || p.includes('/dashboard'); }

// ─── Endpoint key derivation (stable string for DynamoDB key) ─────────────────
function resolveProfile(method, path) {
  return ENDPOINT_PROFILES.find((e) => e.match(method, path)) || DEFAULT_PROFILE;
}

function endpointKey(method, path) {
  if (method === 'POST' && path.includes('webhook'))   return 'webhook:post';
  if (method === 'POST' && path.includes('events'))    return 'events:post';
  if (method === 'GET'  && path.includes('dashboard')) return 'dashboard:get';
  if (method === 'GET'  && path.includes('events'))    return 'events:get';
  return 'default';
}

// ─── Window helpers ───────────────────────────────────────────────────────────
function windowStart(nowMs = Date.now()) {
  return new Date(Math.floor(nowMs / WINDOW_MS) * WINDOW_MS).toISOString();
}

function windowResetMs(nowMs = Date.now()) {
  return Math.floor(nowMs / WINDOW_MS) * WINDOW_MS + WINDOW_MS;
}

// ─── checkRateLimit ───────────────────────────────────────────────────────────
/**
 * Atomically increment the request counter for this (clientId, endpoint, window)
 * triple and return the rate-limit decision.
 *
 * @param {string} clientId    — hashed IP or authenticated userId
 * @param {string} epKey       — stable endpoint identifier
 * @param {{ limit: number, burst: number }} profile
 * @returns {Promise<{ allowed: boolean, remaining: number, resetAt: number }>}
 */
async function checkRateLimit(clientId, epKey, profile) {
  const nowMs     = Date.now();
  const winStart  = windowStart(nowMs);
  const resetAt   = windowResetMs(nowMs);                     // epoch ms
  const itemTtl   = Math.floor(resetAt / 1000) + 60;          // epoch secs, 1 min after reset
  const metricKey = `rl:${clientId}:${epKey}`;
  const ceiling   = profile.limit + profile.burst;

  try {
    const result = await docClient.send(new UpdateCommand({
      TableName:                 RATE_TABLE,
      Key:                       { metricKey, timestamp: winStart },
      UpdateExpression:          'ADD #cnt :one SET #ttl = if_not_exists(#ttl, :ttl)',
      ExpressionAttributeNames:  { '#cnt': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': itemTtl },
      ReturnValues:              'ALL_NEW',
    }));

    const count     = result.Attributes.count;
    const allowed   = count <= ceiling;
    const remaining = Math.max(0, profile.limit - count);

    return { allowed, remaining, resetAt };
  } catch (err) {
    // Fail open — do not block traffic on DynamoDB errors
    logger.error('Rate limiter DynamoDB error — failing open', {
      error:    err.message,
      clientId,
      epKey,
    });
    return { allowed: true, remaining: profile.limit, resetAt };
  }
}

// ─── resolveClientId ─────────────────────────────────────────────────────────
// Prefer authenticated user ID (already hashed in auth middleware) over raw IP.
// Never use the raw API key / JWT — only the stable user identifier.
function resolveClientId(req) {
  if (req.user?.sub)    return `user:${req.user.sub}`;
  if (req.user?.userId) return `user:${req.user.userId}`;
  // Normalise IP — handle X-Forwarded-For (first hop only) and IPv6-mapped IPv4
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (forwarded ? forwarded.split(',')[0] : req.ip || 'unknown').trim();
  return `ip:${ip}`;
}

// ─── setRateLimitHeaders ──────────────────────────────────────────────────────
function setRateLimitHeaders(res, profile, result) {
  res.setHeader('X-RateLimit-Limit',     profile.limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset',     Math.ceil(result.resetAt / 1000));  // Unix epoch (secs)
}

// ─── rateLimiter middleware factory ──────────────────────────────────────────
/**
 * Express middleware.  Call with no args to use per-endpoint automatic profiles,
 * or pass an explicit profile to override: rateLimiter({ limit: 30, burst: 5 })
 *
 * @param {object} [overrideProfile]
 */
const rateLimiter = (overrideProfile) => async (req, res, next) => {
  const method   = req.method.toUpperCase();
  const path     = req.path || '/';
  const epKey    = endpointKey(method, path);
  const profile  = overrideProfile || resolveProfile(method, path);
  const clientId = resolveClientId(req);

  const result = await checkRateLimit(clientId, epKey, profile);

  setRateLimitHeaders(res, profile, result);

  if (!result.allowed) {
    logger.warn('Rate limit exceeded', { clientId, epKey, path, method });
    res.setHeader('Retry-After', Math.ceil((result.resetAt - Date.now()) / 1000));
    return sendError(res, 'Too many requests — please slow down and retry after the reset time', 429);
  }

  next();
};

// ─── Named per-endpoint middleware shortcuts ──────────────────────────────────
// Import these directly onto specific routes for explicit per-route limits.
const limitPostEvents   = rateLimiter({ limit: 100, burst: 20  });
const limitPostWebhook  = rateLimiter({ limit: 500, burst: 100 });
const limitGetEvents    = rateLimiter({ limit: 200, burst: 40  });
const limitGetDashboard = rateLimiter({ limit: 60,  burst: 10  });

module.exports = {
  rateLimiter,         // generic factory — auto-detects endpoint
  checkRateLimit,      // pure function for testing / programmatic use
  resolveClientId,
  // Named shortcuts
  limitPostEvents,
  limitPostWebhook,
  limitGetEvents,
  limitGetDashboard,
  // Internals exposed for tests
  _resolveProfile: resolveProfile,
  _windowStart:    windowStart,
};

'use strict';

/**
 * security.js — request-pipeline security middleware
 *
 * Exports:
 *   securityHeaders   — Helmet-equivalent response headers
 *   cors              — CORS preflight + header injection
 *   requestLogger     — structured request/response logging (sensitive data scrubbed)
 *   ipAllowlist       — optional IP allowlisting (CIDR-aware)
 *   webhookSignature  — signature verification helpers for GitHub, Stripe, Datadog, generic
 */

const crypto = require('crypto');
const logger  = require('../utils/logger');
const { error: sendError } = require('../utils/response');

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Allowed origins: comma-separated list in CORS_ORIGINS env var.
// Empty / unset  → same-origin only (production safe default).
// "*"            → open (use only in dev/test).
const RAW_ORIGINS  = (process.env.CORS_ORIGINS || '').trim();
const ALLOWED_ORIGINS = RAW_ORIGINS
  ? RAW_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : [];
const OPEN_CORS    = ALLOWED_ORIGINS.includes('*');

const CORS_METHODS  = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const CORS_HEADERS  = 'Content-Type,Authorization,X-API-Key,X-Request-ID,X-Correlation-ID';
const CORS_EXPOSE   = 'X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,X-Request-ID';
const CORS_MAX_AGE  = '600';   // seconds to cache preflight

/**
 * CORS middleware.
 * On OPTIONS preflight: set headers and return 204.
 * On all other requests: set Access-Control-Allow-Origin if origin matches.
 */
const cors = (req, res, next) => {
  const origin = req.headers['origin'] || '';

  const allowed =
    OPEN_CORS ||
    (origin && ALLOWED_ORIGINS.includes(origin));

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin',      OPEN_CORS ? '*' : origin);
    res.setHeader('Access-Control-Allow-Methods',     CORS_METHODS);
    res.setHeader('Access-Control-Allow-Headers',     CORS_HEADERS);
    res.setHeader('Access-Control-Expose-Headers',    CORS_EXPOSE);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age',           CORS_MAX_AGE);
  }

  // Short-circuit preflight — no body needed
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
};

// ─── Security headers ─────────────────────────────────────────────────────────
// Applied to every response.  Mirrors what Helmet sets without the dependency.
const CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = (req, res, next) => {
  // Transport
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');

  // MIME sniffing
  res.setHeader('X-Content-Type-Options',    'nosniff');

  // Clickjacking
  res.setHeader('X-Frame-Options',           'DENY');

  // XSS (legacy browsers)
  res.setHeader('X-XSS-Protection',          '1; mode=block');

  // Referrer
  res.setHeader('Referrer-Policy',           'strict-origin-when-cross-origin');

  // Content-Security-Policy (API — no HTML served, so very restrictive)
  res.setHeader('Content-Security-Policy',   CSP);

  // Permissions policy — deny all browser features
  res.setHeader('Permissions-Policy',        'geolocation=(), microphone=(), camera=()');

  // Cache control — prevent sensitive API responses from being cached
  res.setHeader('Cache-Control',             'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma',                    'no-cache');
  res.setHeader('Expires',                   '0');
  res.setHeader('Surrogate-Control',         'no-store');

  // Hide server identity
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');

  next();
};

// ─── Request logger ───────────────────────────────────────────────────────────
// Logs one line at request start and one at response finish.
// Sensitive headers and body fields are scrubbed before logging.

const SCRUB_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie', 'x-webhook-secret']);
const SCRUB_FIELDS  = new Set(['password', 'passwordHash', 'secret', 'token', 'apiKey', 'apiKeyHash',
                               'creditCard', 'ssn', 'pin']);

function scrubHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SCRUB_HEADERS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

function scrubBody(body, depth = 0) {
  if (depth > 4 || body === null || typeof body !== 'object') return body;
  if (Array.isArray(body)) return body.map((v) => scrubBody(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    out[k] = SCRUB_FIELDS.has(k) ? '[REDACTED]' : scrubBody(v, depth + 1);
  }
  return out;
}

const requestLogger = (req, res, next) => {
  const startMs    = Date.now();
  const requestId  = req.headers['x-request-id'] || req.headers['x-correlation-id'] || undefined;

  logger.info('Request received', {
    requestId,
    method:   req.method,
    path:     req.path,
    query:    req.query,
    headers:  scrubHeaders(req.headers),
    userId:   req.user?.sub,
    ip:       req.ip,
  });

  // Patch res.json so we can log the outbound status without monkey-patching end()
  const _json = res.json.bind(res);
  res.json = (body) => {
    const durationMs = Date.now() - startMs;
    logger.info('Request completed', {
      requestId,
      method:     req.method,
      path:       req.path,
      statusCode: res.statusCode,
      durationMs,
      userId:     req.user?.sub,
    });
    return _json(body);
  };

  next();
};

// ─── IP allowlisting ──────────────────────────────────────────────────────────
// Set IP_ALLOWLIST=10.0.0.0/8,192.168.1.5 in env to restrict access.
// Leave unset (or empty) to disable the check entirely.
// Supports exact IPs and IPv4 CIDR notation.

const RAW_ALLOWLIST = (process.env.IP_ALLOWLIST || '').trim();
const ALLOWLIST_ENTRIES = RAW_ALLOWLIST
  ? RAW_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
const ALLOWLIST_ENABLED = ALLOWLIST_ENTRIES.length > 0;

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return NaN;
  return parts.reduce((acc, octet) => {
    const n = parseInt(octet, 10);
    return isNaN(n) || n < 0 || n > 255 ? NaN : (acc * 256 + n);
  }, 0);
}

function cidrContains(cidr, ip) {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx === -1) {
    // Exact IP match
    return cidr === ip;
  }
  const network = cidr.slice(0, slashIdx);
  const prefix  = parseInt(cidr.slice(slashIdx + 1), 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;

  const mask    = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const netInt  = ipToInt(network) >>> 0;
  const ipInt   = ipToInt(ip)      >>> 0;
  return (netInt & mask) === (ipInt & mask);
}

function isAllowed(ip) {
  if (!ALLOWLIST_ENABLED) return true;
  // Strip IPv6-mapped IPv4 prefix (::ffff:1.2.3.4 → 1.2.3.4)
  const cleanIp = ip.replace(/^::ffff:/, '');
  return ALLOWLIST_ENTRIES.some((entry) => cidrContains(entry, cleanIp));
}

/**
 * IP allowlist middleware.
 * No-op when IP_ALLOWLIST env var is not set.
 */
const ipAllowlist = (req, res, next) => {
  if (!ALLOWLIST_ENABLED) return next();

  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  if (!isAllowed(ip)) {
    logger.warn('IP blocked by allowlist', { ip, path: req.path });
    return sendError(res, 'Access denied', 403);
  }
  next();
};

// ─── Webhook signature verification helpers ───────────────────────────────────
// Standalone helpers that any handler can import.  These mirror the logic in
// webhookReceiver.js but are decoupled from the Lambda event structure so they
// work inside Express request handlers too.

/** HMAC-SHA256 hex digest. */
function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

/**
 * Timing-safe string comparison (pads to same length to prevent short-circuit).
 * Always runs in O(max(|a|,|b|)) time regardless of where strings diverge.
 */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);   // constant-time dummy compare
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a GitHub webhook.
 * Header: X-Hub-Signature-256: sha256=<hex>
 *
 * @param {string|Buffer} rawBody  — raw (un-parsed) request body
 * @param {object}        headers  — request headers (any casing; normalised internally)
 * @param {string}        secret   — GITHUB_WEBHOOK_SECRET
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyGitHubSignature(rawBody, headers, secret) {
  const norm = normaliseHeaders(headers);
  const sig  = norm['x-hub-signature-256'] || '';
  if (!sig)                       return { valid: false, reason: 'X-Hub-Signature-256 header missing' };
  if (!sig.startsWith('sha256=')) return { valid: false, reason: 'X-Hub-Signature-256 must start with sha256=' };

  const expected = `sha256=${hmacHex(secret, rawBody)}`;
  return timingSafeEqual(expected, sig)
    ? { valid: true }
    : { valid: false, reason: 'GitHub signature mismatch' };
}

/**
 * Verify a Stripe webhook.
 * Header: Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]
 *
 * Signed payload: "<t>.<rawBody>"
 *
 * @param {string} rawBody
 * @param {object} headers
 * @param {string} secret   — STRIPE_WEBHOOK_SECRET
 * @returns {{ valid: boolean, reason?: string, timestamp?: number }}
 */
function verifyStripeSignature(rawBody, headers, secret) {
  const norm   = normaliseHeaders(headers);
  const sigHdr = norm['stripe-signature'] || '';
  if (!sigHdr) return { valid: false, reason: 'Stripe-Signature header missing' };

  const parts = {};
  for (const part of sigHdr.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!parts[k]) parts[k] = [];
    parts[k].push(v);
  }

  const t  = parts.t?.[0];
  const v1 = parts.v1 || [];
  if (!t || v1.length === 0) return { valid: false, reason: 'Stripe-Signature malformed (missing t or v1)' };

  const signed   = `${t}.${rawBody}`;
  const expected = hmacHex(secret, signed);
  const matched  = v1.some((s) => timingSafeEqual(expected, s));
  return matched
    ? { valid: true, timestamp: parseInt(t, 10) }
    : { valid: false, reason: 'Stripe signature mismatch' };
}

/**
 * Verify a Datadog webhook.
 * Header: DD-Signature (or X-Datadog-Signature): <hex>
 *
 * @param {string} rawBody
 * @param {object} headers
 * @param {string} secret   — DATADOG_WEBHOOK_SECRET
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyDatadogSignature(rawBody, headers, secret) {
  const norm = normaliseHeaders(headers);
  const sig  = norm['dd-signature'] || norm['x-datadog-signature'] || '';
  if (!sig) return { valid: false, reason: 'DD-Signature or X-Datadog-Signature header missing' };

  const expected = hmacHex(secret, rawBody);
  return timingSafeEqual(expected, sig)
    ? { valid: true }
    : { valid: false, reason: 'Datadog signature mismatch' };
}

/**
 * Verify a generic webhook using a shared secret.
 * Header: X-Webhook-Secret: <secret>
 *
 * @param {object} headers
 * @param {string} secret   — GENERIC_WEBHOOK_SECRET
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyGenericSignature(headers, secret) {
  const norm     = normaliseHeaders(headers);
  const provided = norm['x-webhook-secret'] || '';
  if (!provided) return { valid: false, reason: 'X-Webhook-Secret header missing' };

  return timingSafeEqual(secret, provided)
    ? { valid: true }
    : { valid: false, reason: 'Webhook secret mismatch' };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
function normaliseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

// ─── Combined security stack ──────────────────────────────────────────────────
// Convenience array: app.use(securityStack)
const securityStack = [cors, securityHeaders, requestLogger, ipAllowlist];

module.exports = {
  // Middleware
  cors,
  securityHeaders,
  requestLogger,
  ipAllowlist,
  securityStack,          // all four composed together

  // Webhook signature helpers
  verifyGitHubSignature,
  verifyStripeSignature,
  verifyDatadogSignature,
  verifyGenericSignature,

  // Exported for tests
  _isAllowed:         isAllowed,
  _cidrContains:      cidrContains,
  _timingSafeEqual:   timingSafeEqual,
  _scrubHeaders:      scrubHeaders,
  _scrubBody:         scrubBody,
};

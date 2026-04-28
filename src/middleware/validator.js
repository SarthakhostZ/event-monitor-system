'use strict';

const logger = require('../utils/logger');
const { error } = require('../utils/response');

const MAX_BODY_BYTES   = 1 * 1024 * 1024; // 1 MB
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

// ─── XSS sanitization ────────────────────────────────────────────────────────
// Escapes the five HTML-sensitive characters plus forward-slash in every string
// value found anywhere in the request body / query / params.  Arrays and nested
// objects are walked recursively.  Non-string primitives are left untouched.
const HTML_ESCAPE = {
  '&':  '&amp;',
  '<':  '&lt;',
  '>':  '&gt;',
  '"':  '&quot;',
  "'":  '&#x27;',
  '/':  '&#x2F;',
};

function escapeHtml(str) {
  return str.replace(/[&<>"'/]/g, (ch) => HTML_ESCAPE[ch]);
}

function sanitizeValue(value) {
  if (typeof value === 'string')  return escapeHtml(value);
  if (Array.isArray(value))       return value.map(sanitizeValue);
  if (value !== null && typeof value === 'object') return _sanitizeObject(value);
  return value;
}

function _sanitizeObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = sanitizeValue(v);
  }
  return out;
}

// ─── validateContentType middleware ──────────────────────────────────────────
// Rejects POST / PUT / PATCH requests whose Content-Type is not application/json.
const validateContentType = (req, res, next) => {
  if (!METHODS_WITH_BODY.has(req.method)) return next();

  const raw      = req.headers['content-type'] || '';
  const baseType = raw.split(';')[0].trim().toLowerCase();

  if (baseType !== 'application/json') {
    return error(
      res,
      `Unsupported Content-Type "${baseType || '(none)'}". Expected application/json`,
      415,
    );
  }
  next();
};

// ─── checkBodySize middleware ─────────────────────────────────────────────────
// Uses the Content-Length header for an early-exit check before the body has
// been read.  Express's built-in body parser enforces the limit at the byte
// level via its `limit` option, so this adds a fast pre-check and a clear error.
const checkBodySize = (req, res, next) => {
  const contentLength = parseInt(req.headers['content-length'], 10);
  if (!Number.isNaN(contentLength) && contentLength > MAX_BODY_BYTES) {
    logger.warn('Request body too large', {
      contentLength,
      limitBytes: MAX_BODY_BYTES,
      path: req.path,
      method: req.method,
    });
    return error(res, 'Request body exceeds the 1 MB size limit', 413);
  }
  next();
};

// ─── sanitizeInput middleware ─────────────────────────────────────────────────
// Walks req.body, req.query, and req.params and HTML-escapes every string value.
// Runs after body parsing so req.body is already a plain object.
const sanitizeInput = (req, res, next) => {
  if (req.body   && typeof req.body   === 'object') req.body   = _sanitizeObject(req.body);
  if (req.query  && typeof req.query  === 'object') req.query  = _sanitizeObject(req.query);
  if (req.params && typeof req.params === 'object') req.params = _sanitizeObject(req.params);
  next();
};

// ─── Combined middleware array ────────────────────────────────────────────────
// Use as:  router.use(sanitize)  or  router.post('/path', ...sanitize, handler)
const sanitize = [validateContentType, checkBodySize, sanitizeInput];

module.exports = {
  validateContentType,
  checkBodySize,
  sanitizeInput,
  sanitize,
  // Exported for unit tests and explicit use in services
  escapeHtml,
  sanitizeValue,
};

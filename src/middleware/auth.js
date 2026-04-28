'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../services/dynamodb');
const config = require('../config');
const logger = require('../utils/logger');
const { error } = require('../utils/response');

// ─── Role → permissions map ───────────────────────────────────────────────────
const ROLE_PERMISSIONS = {
  admin:    ['*'],
  operator: ['create:events', 'read:events', 'read:dashboard', 'read:alerts', 'create:webhooks'],
  viewer:   ['read:events', 'read:dashboard'],
};

// ─── JWT algorithm & key selection ───────────────────────────────────────────
// Set JWT_PRIVATE_KEY / JWT_PUBLIC_KEY (base64-encoded PEM) in env for RS256.
// Falls back to HS256 using JWT_SECRET when those vars are absent.
const _privateKey = process.env.JWT_PRIVATE_KEY
  ? Buffer.from(process.env.JWT_PRIVATE_KEY, 'base64').toString('utf8')
  : null;
const _publicKey = process.env.JWT_PUBLIC_KEY
  ? Buffer.from(process.env.JWT_PUBLIC_KEY, 'base64').toString('utf8')
  : null;
const USE_RS256   = !!(_privateKey && _publicKey);
const SIGN_KEY    = USE_RS256 ? _privateKey  : config.jwt.secret;
const VERIFY_KEY  = USE_RS256 ? _publicKey   : config.jwt.secret;
const ALGORITHM   = USE_RS256 ? 'RS256'      : 'HS256';

const JWT_ISSUER   = process.env.JWT_ISSUER   || config.app.name;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'event-monitor-api';
const JWT_EXPIRY   = process.env.JWT_EXPIRY   || config.jwt.expiresIn || '1h';

// ─── In-memory token cache (5-minute TTL) ────────────────────────────────────
// Key: SHA-256 hash of the raw token string (never the token itself).
const _tokenCache  = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function _cacheGet(tokenHash) {
  const entry = _tokenCache.get(tokenHash);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _tokenCache.delete(tokenHash);
    return null;
  }
  return entry.claims;
}

function _cacheSet(tokenHash, claims, tokenExpSec) {
  const expiresAt = Math.min(Date.now() + CACHE_TTL_MS, tokenExpSec * 1000);
  _tokenCache.set(tokenHash, { claims, expiresAt });
}

// ─── Per-API-key in-memory rate limiter ──────────────────────────────────────
const _apiKeyRates  = new Map();
const APIKEY_WINDOW = 60_000;  // 1 minute
const APIKEY_MAX    = 200;     // requests per window per key

function _checkApiKeyRate(keyHash) {
  const now = Date.now();
  const entry = _apiKeyRates.get(keyHash) || { count: 0, resetAt: now + APIKEY_WINDOW };
  if (now > entry.resetAt) {
    entry.count  = 0;
    entry.resetAt = now + APIKEY_WINDOW;
  }
  entry.count += 1;
  _apiKeyRates.set(keyHash, entry);
  return entry.count <= APIKEY_MAX;
}

// ─── extractToken ─────────────────────────────────────────────────────────────
// Reads credentials from the request.  Returns { type, value } or null.
function extractToken(req) {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    return { type: 'bearer', value: auth.slice(7).trim() };
  }
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    return { type: 'apikey', value: apiKey.trim() };
  }
  return null;
}

// ─── verifyToken ──────────────────────────────────────────────────────────────
// Verifies the JWT, checks exp / iss / aud, and caches the result for 5 min.
function verifyToken(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const cached = _cacheGet(tokenHash);
  if (cached) return cached;

  const claims = jwt.verify(token, VERIFY_KEY, {
    algorithms: [ALGORITHM],
    issuer:     JWT_ISSUER,
    audience:   JWT_AUDIENCE,
  });

  _cacheSet(tokenHash, claims, claims.exp);
  return claims;
}

// ─── validateApiKey ───────────────────────────────────────────────────────────
// Hashes the raw key, enforces per-key rate limit, then looks up in DynamoDB.
// Requires an `apiKey-index` GSI on the users table with `apiKeyHash` as PK.
async function validateApiKey(rawKey) {
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  if (!_checkApiKeyRate(keyHash)) {
    throw Object.assign(new Error('API key rate limit exceeded'), { statusCode: 429 });
  }

  const { items } = await db.query(config.dynamodb.usersTable, {
    IndexName: 'apiKey-index',
    KeyConditionExpression: 'apiKeyHash = :h',
    ExpressionAttributeValues: { ':h': keyHash },
  });

  if (!items.length) {
    throw Object.assign(new Error('Invalid API key'), { statusCode: 401 });
  }

  const user = items[0];
  if (user.apiKeyRevoked) {
    throw Object.assign(new Error('API key has been revoked'), { statusCode: 401 });
  }

  return {
    sub:         user.id,
    userId:      user.id,
    email:       user.email,
    role:        user.role,
    permissions: ROLE_PERMISSIONS[user.role] || [],
    authMethod:  'apikey',
  };
}

// ─── generateToken ────────────────────────────────────────────────────────────
// Creates a signed JWT (1-hour expiry) embedding userId, role, and permissions.
function generateToken(user) {
  const permissions = ROLE_PERMISSIONS[user.role] || [];
  return jwt.sign(
    {
      sub:         user.id || user.sub,
      userId:      user.id || user.sub,
      email:       user.email,
      role:        user.role,
      permissions,
    },
    SIGN_KEY,
    {
      algorithm:  ALGORITHM,
      expiresIn:  JWT_EXPIRY,
      issuer:     JWT_ISSUER,
      audience:   JWT_AUDIENCE,
    },
  );
}

// ─── API key helpers ──────────────────────────────────────────────────────────
// Generate a cryptographically random API key (hex string).
function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

// Hash a raw API key for safe storage in DynamoDB.
function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// ─── authenticate middleware ──────────────────────────────────────────────────
const authenticate = async (req, res, next) => {
  const extracted = extractToken(req);
  if (!extracted) {
    return error(res, 'Missing authentication credentials', 401);
  }

  try {
    if (extracted.type === 'bearer') {
      const claims = verifyToken(extracted.value);
      req.user = {
        ...claims,
        permissions: claims.permissions || ROLE_PERMISSIONS[claims.role] || [],
        authMethod: 'jwt',
      };
    } else {
      req.user = await validateApiKey(extracted.value);
    }
    next();
  } catch (err) {
    const message =
      err.name === 'TokenExpiredError'   ? 'Token has expired'  :
      err.name === 'JsonWebTokenError'   ? 'Invalid token'      :
      err.name === 'NotBeforeError'      ? 'Token not yet valid':
      err.message || 'Authentication failed';
    const status = err.statusCode || 401;
    logger.warn('Authentication failure', { path: req.path, reason: err.name || err.message });
    return error(res, message, status);
  }
};

// ─── authorize HOF ────────────────────────────────────────────────────────────
// Usage:
//   authorize('admin')              — role must be admin
//   authorize('admin', 'operator')  — role must be admin OR operator
//   authorize('create:events')      — role must carry that permission
//
// Admin always passes (wildcard).  Role names use an inclusion list (OR logic),
// preserving the existing behaviour used across the route files.
const authorize = (...allowed) => (req, res, next) => {
  if (!req.user) {
    return error(res, 'Not authenticated', 401);
  }

  const { role, permissions = [] } = req.user;
  const userPerms = permissions.length ? permissions : (ROLE_PERMISSIONS[role] || []);

  if (userPerms.includes('*')) return next(); // admin wildcard

  const ROLES = ['admin', 'operator', 'viewer'];
  const granted = allowed.some((requirement) => {
    if (ROLES.includes(requirement)) {
      // Role name — check direct match
      return role === requirement;
    }
    // Permission string — check inclusion
    return userPerms.includes(requirement);
  });

  if (!granted) {
    logger.warn('Authorization denied', { userId: req.user.sub, role, required: allowed });
    return error(res, 'Insufficient permissions', 403);
  }
  next();
};

module.exports = {
  authenticate,
  authorize,
  extractToken,
  verifyToken,
  generateToken,
  generateApiKey,
  hashApiKey,
  ROLE_PERMISSIONS,
};

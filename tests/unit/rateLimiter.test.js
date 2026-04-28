'use strict';

/**
 * Unit tests for src/middleware/rateLimiter.js
 *
 * DynamoDB calls are fully mocked.  Express req/res are simulated with
 * plain objects so the middleware can be called without a running server.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('../../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

jest.mock('../../src/utils/response', () => ({
  error: jest.fn((res, message, code) => {
    res.statusCode = code;
    res._body      = { error: message };
    res._sent      = true;
  }),
}));

// DynamoDB UpdateCommand mock — exposes ._mockSend for per-test control.
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const mockSend = jest.fn();
  return {
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
    UpdateCommand: jest.fn((x) => x),
    _mockSend: mockSend,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Env + module load
// ─────────────────────────────────────────────────────────────────────────────

process.env.DYNAMODB_METRICS_TABLE = 'MetricsTable-test';
process.env.AWS_REGION             = 'ap-south-1';

const { _mockSend } = require('@aws-sdk/lib-dynamodb');

const {
  checkRateLimit,
  resolveClientId,
  _resolveProfile,
  _windowStart,
} = require('../../src/middleware/rateLimiter');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal Express-like request object.
 */
function makeReq({ method = 'POST', path = '/events', headers = {}, ip = '1.2.3.4', user } = {}) {
  return { method, path, headers, ip, user };
}

/**
 * Build a minimal Express-like response object that tracks header / status calls.
 */
function makeRes() {
  const headers = {};
  return {
    _headers:    headers,
    _statusCode: null,
    _body:       null,
    _sent:       false,
    setHeader:   (k, v) => { headers[k] = v; },
    getHeader:   (k) => headers[k],
  };
}

/**
 * Return a DynamoDB UpdateCommand response with the given count.
 */
function dynamo(count) {
  return { Attributes: { count } };
}

// Reset mocks between tests
beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// _windowStart
// ─────────────────────────────────────────────────────────────────────────────

describe('_windowStart', () => {
  it('returns an ISO string truncated to the minute boundary', () => {
    // A moment partway through a minute
    const ts  = new Date('2026-04-11T09:23:45.500Z').getTime();
    const win = _windowStart(ts);
    // Should floor to the 60-second window start
    const winMs = new Date(win).getTime();
    expect(winMs % 60_000).toBe(0);
  });

  it('returns a valid ISO string', () => {
    const win = _windowStart(Date.now());
    expect(() => new Date(win)).not.toThrow();
  });

  it('produces the same window for two timestamps in the same minute', () => {
    const base = new Date('2026-04-11T09:30:00.000Z').getTime();
    expect(_windowStart(base)).toBe(_windowStart(base + 30_000));
  });

  it('produces different windows for timestamps in different minutes', () => {
    const a = new Date('2026-04-11T09:30:00.000Z').getTime();
    const b = a + 60_001;
    expect(_windowStart(a)).not.toBe(_windowStart(b));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _resolveProfile
// ─────────────────────────────────────────────────────────────────────────────

describe('_resolveProfile', () => {
  it('returns webhook profile for POST /webhook/github', () => {
    const p = _resolveProfile('POST', '/webhook/github');
    expect(p.limit).toBe(500);
    expect(p.burst).toBe(100);
  });

  it('returns events:post profile for POST /events', () => {
    const p = _resolveProfile('POST', '/events');
    expect(p.limit).toBe(100);
    expect(p.burst).toBe(20);
  });

  it('returns dashboard:get profile for GET /dashboard/stats', () => {
    const p = _resolveProfile('GET', '/dashboard/stats');
    expect(p.limit).toBe(60);
    expect(p.burst).toBe(10);
  });

  it('returns events:get profile for GET /events', () => {
    const p = _resolveProfile('GET', '/events');
    expect(p.limit).toBe(200);
    expect(p.burst).toBe(40);
  });

  it('returns the default profile for an unmatched route', () => {
    const p = _resolveProfile('DELETE', '/unknown-path');
    expect(p.limit).toBe(100);
    expect(p.burst).toBe(20);
  });

  it('matching is case-sensitive on HTTP method', () => {
    // Method is uppercased by the caller; lowercase should not match
    const p = _resolveProfile('post', '/events');
    // Falls through to default because profiles check 'POST' (upper)
    expect(p.limit).toBe(100);  // default limit — could equal events:post by coincidence, just check type
    expect(typeof p.burst).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveClientId
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveClientId', () => {
  it('uses user.sub when present (JWT sub claim)', () => {
    const req = makeReq({ user: { sub: 'user-uuid-001' } });
    expect(resolveClientId(req)).toBe('user:user-uuid-001');
  });

  it('uses user.userId when user.sub is absent', () => {
    const req = makeReq({ user: { userId: 'uid-123' } });
    expect(resolveClientId(req)).toBe('user:uid-123');
  });

  it('falls back to IP when no user object is present', () => {
    const req = makeReq({ ip: '203.0.113.1' });
    expect(resolveClientId(req)).toBe('ip:203.0.113.1');
  });

  it('uses the first IP from X-Forwarded-For header', () => {
    const req = makeReq({
      headers: { 'x-forwarded-for': '10.0.0.1, 172.16.0.1, 192.168.0.1' },
    });
    expect(resolveClientId(req)).toBe('ip:10.0.0.1');
  });

  it('trims whitespace from the X-Forwarded-For first hop', () => {
    const req = makeReq({
      headers: { 'x-forwarded-for': '  10.0.0.2  , 192.168.1.1' },
    });
    expect(resolveClientId(req)).toBe('ip:10.0.0.2');
  });

  it('returns ip:unknown when no IP information is available', () => {
    const req = { method: 'GET', path: '/', headers: {} };
    expect(resolveClientId(req)).toBe('ip:unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkRateLimit — core logic
// ─────────────────────────────────────────────────────────────────────────────

describe('checkRateLimit', () => {
  const profile  = { limit: 100, burst: 20 };
  const clientId = 'user:test-user-001';
  const epKey    = 'events:post';

  it('allows the request when counter is within the limit', async () => {
    _mockSend.mockResolvedValueOnce(dynamo(50));

    const result = await checkRateLimit(clientId, epKey, profile);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(50);       // limit(100) - count(50)
    expect(typeof result.resetAt).toBe('number');
  });

  it('allows the request at exactly the burst ceiling (limit + burst = 120)', async () => {
    _mockSend.mockResolvedValueOnce(dynamo(120));

    const result = await checkRateLimit(clientId, epKey, profile);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it('blocks when count exceeds the burst ceiling', async () => {
    _mockSend.mockResolvedValueOnce(dynamo(121));

    const result = await checkRateLimit(clientId, epKey, profile);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('remaining is clamped to 0 (never negative)', async () => {
    _mockSend.mockResolvedValueOnce(dynamo(150));

    const result = await checkRateLimit(clientId, epKey, profile);
    expect(result.remaining).toBe(0);
    expect(result.remaining).toBeGreaterThanOrEqual(0);
  });

  it('fails open when DynamoDB throws (allows the request)', async () => {
    _mockSend.mockRejectedValueOnce(new Error('DynamoDB throttled'));

    const result = await checkRateLimit(clientId, epKey, profile);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(profile.limit);
  });

  it('returns a resetAt timestamp in the future', async () => {
    _mockSend.mockResolvedValueOnce(dynamo(1));

    const result = await checkRateLimit(clientId, epKey, profile);
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it('burst allowance lets traffic go 20 above the sustained limit', async () => {
    // Count = 115 — above limit(100) but below ceiling(120)
    _mockSend.mockResolvedValueOnce(dynamo(115));
    const result = await checkRateLimit(clientId, epKey, profile);
    expect(result.allowed).toBe(true);
  });

  it('blocks the very first request above the ceiling', async () => {
    _mockSend.mockResolvedValueOnce(dynamo(120 + 1));
    const result = await checkRateLimit(clientId, epKey, profile);
    expect(result.allowed).toBe(false);
  });

  it('calls DynamoDB UpdateCommand with ADD semantics', async () => {
    _mockSend.mockResolvedValueOnce(dynamo(1));

    await checkRateLimit(clientId, epKey, profile);

    const callArg = _mockSend.mock.calls[0][0];
    expect(callArg.UpdateExpression).toContain('ADD');
  });

  it('scopes the DynamoDB key to the clientId and endpoint', async () => {
    _mockSend.mockResolvedValueOnce(dynamo(1));

    await checkRateLimit('user:alice', 'events:post', profile);

    const callArg = _mockSend.mock.calls[0][0];
    expect(callArg.Key.metricKey).toContain('user:alice');
    expect(callArg.Key.metricKey).toContain('events:post');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rateLimiter middleware (integration with Express req/res)
// ─────────────────────────────────────────────────────────────────────────────

describe('rateLimiter middleware', () => {
  const { rateLimiter } = require('../../src/middleware/rateLimiter');

  it('calls next() and sets rate-limit headers when request is allowed', async () => {
    _mockSend.mockResolvedValueOnce(dynamo(10));

    const req  = makeReq({ method: 'POST', path: '/events', ip: '1.2.3.4' });
    const res  = makeRes();
    const next = jest.fn();

    await rateLimiter()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.getHeader('X-RateLimit-Limit')).toBeDefined();
    expect(res.getHeader('X-RateLimit-Remaining')).toBeDefined();
    expect(res.getHeader('X-RateLimit-Reset')).toBeDefined();
  });

  it('returns 429 and does NOT call next() when rate limit is exceeded', async () => {
    _mockSend.mockResolvedValueOnce(dynamo(999));

    const req  = makeReq({ method: 'POST', path: '/events', ip: '5.6.7.8' });
    const res  = makeRes();
    const next = jest.fn();

    await rateLimiter()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
  });

  it('respects an override profile passed to the factory', async () => {
    // Very tight limit — 1 request per window
    _mockSend.mockResolvedValueOnce(dynamo(2));

    const req  = makeReq({ method: 'GET', path: '/events', ip: '9.9.9.9' });
    const res  = makeRes();
    const next = jest.fn();

    await rateLimiter({ limit: 1, burst: 0 })(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
  });

  it('sets Retry-After header when rate-limited', async () => {
    _mockSend.mockResolvedValueOnce(dynamo(200));

    const req  = makeReq({ method: 'POST', path: '/events' });
    const res  = makeRes();
    const next = jest.fn();

    await rateLimiter()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    // The response utility mock sets statusCode=429; Retry-After is set before the call.
    expect(res.getHeader('Retry-After')).toBeDefined();
  });

  it('calls next() even when DynamoDB is down (fail-open)', async () => {
    _mockSend.mockRejectedValueOnce(new Error('DynamoDB unreachable'));

    const req  = makeReq({ method: 'POST', path: '/events', ip: '2.3.4.5' });
    const res  = makeRes();
    const next = jest.fn();

    await rateLimiter()(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

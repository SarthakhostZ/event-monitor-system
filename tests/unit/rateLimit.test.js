'use strict';

/**
 * Unit tests for src/middleware/rateLimit.js
 * Uses in-process Map store — no Redis/DynamoDB needed.
 */

// Mock response util
jest.mock('../../src/utils/response', () => ({
  error: jest.fn((res, msg, code) => {
    res.statusCode = code;
    res._body = { message: msg };
    res._sent = true;
  }),
}));

// Pre-set config values before requiring rateLimit
jest.mock('../../src/config', () => ({
  rateLimit: { windowMs: 60000, max: 5 },
}));

const { rateLimit } = require('../../src/middleware/rateLimit');

function makeReq(ip = '127.0.0.1') {
  return { ip };
}

function makeRes() {
  const headers = {};
  return {
    statusCode: null,
    _body: null,
    _sent: false,
    setHeader(k, v) { headers[k] = v; this._headers = headers; },
    _headers: headers,
  };
}

beforeEach(() => {
  // Reset the module's internal store between tests by re-requiring
  jest.resetModules();
});

describe('rateLimit middleware', () => {
  it('allows requests within the limit', () => {
    jest.mock('../../src/config', () => ({ rateLimit: { windowMs: 60000, max: 5 } }));
    jest.mock('../../src/utils/response', () => ({
      error: jest.fn((res, msg, code) => { res.statusCode = code; res._sent = true; }),
    }));
    const { rateLimit: rl } = require('../../src/middleware/rateLimit');
    const middleware = rl(60000, 5);
    const req = makeReq('10.0.0.1');
    const next = jest.fn();

    middleware(req, makeRes(), next);
    middleware(req, makeRes(), next);
    middleware(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(3);
  });

  it('blocks requests that exceed the max', () => {
    jest.mock('../../src/config', () => ({ rateLimit: { windowMs: 60000, max: 5 } }));
    const mockError = jest.fn((res, msg, code) => { res.statusCode = code; res._sent = true; });
    jest.mock('../../src/utils/response', () => ({ error: mockError }));
    const { rateLimit: rl } = require('../../src/middleware/rateLimit');
    const middleware = rl(60000, 2);
    const req = makeReq('10.0.0.2');
    const next = jest.fn();

    middleware(req, makeRes(), next);  // count = 1 (allowed)
    middleware(req, makeRes(), next);  // count = 2 (allowed)
    const res3 = makeRes();
    middleware(req, res3, next);        // count = 3 (exceeds max=2 → blocked)

    expect(next).toHaveBeenCalledTimes(2);
    expect(res3.statusCode).toBe(429);
  });

  it('sets X-RateLimit headers', () => {
    jest.mock('../../src/config', () => ({ rateLimit: { windowMs: 60000, max: 5 } }));
    jest.mock('../../src/utils/response', () => ({
      error: jest.fn((res, msg, code) => { res.statusCode = code; res._sent = true; }),
    }));
    const { rateLimit: rl } = require('../../src/middleware/rateLimit');
    const middleware = rl(60000, 10);
    const req = makeReq('10.0.0.3');
    const res = makeRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res._headers['X-RateLimit-Limit']).toBe(10);
    expect(res._headers['X-RateLimit-Remaining']).toBe(9);
    expect(typeof res._headers['X-RateLimit-Reset']).toBe('number');
  });

  it('resets count after the window expires', () => {
    jest.useFakeTimers();
    jest.mock('../../src/config', () => ({ rateLimit: { windowMs: 1000, max: 5 } }));
    jest.mock('../../src/utils/response', () => ({
      error: jest.fn((res, msg, code) => { res.statusCode = code; res._sent = true; }),
    }));
    const { rateLimit: rl } = require('../../src/middleware/rateLimit');
    const middleware = rl(1000, 1);
    const req = makeReq('10.0.0.4');
    const next = jest.fn();

    middleware(req, makeRes(), next);  // count = 1 (OK)
    const res2 = makeRes();
    middleware(req, res2, next);        // count = 2 (blocked)
    expect(res2.statusCode).toBe(429);

    jest.advanceTimersByTime(2000);     // window expires

    const res3 = makeRes();
    middleware(req, res3, next);        // count = 1 again (OK)
    expect(res3.statusCode).toBeNull();

    jest.useRealTimers();
  });

  it('treats missing IP as "unknown" key', () => {
    jest.mock('../../src/config', () => ({ rateLimit: { windowMs: 60000, max: 5 } }));
    jest.mock('../../src/utils/response', () => ({
      error: jest.fn((res, msg, code) => { res.statusCode = code; res._sent = true; }),
    }));
    const { rateLimit: rl } = require('../../src/middleware/rateLimit');
    const middleware = rl(60000, 5);
    const req = { ip: undefined };
    const next = jest.fn();
    middleware(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });
});

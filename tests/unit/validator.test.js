'use strict';

/**
 * Unit tests for src/middleware/validator.js
 *
 * All exports are pure middleware functions — tested without a running server.
 */

jest.mock('../../src/utils/logger', () => ({
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/utils/response', () => ({
  error: jest.fn((res, message, code) => {
    res.statusCode = code;
    res._body = { message };
    res._sent = true;
  }),
}));

const {
  escapeHtml,
  sanitizeValue,
  validateContentType,
  checkBodySize,
  sanitizeInput,
  sanitize,
} = require('../../src/middleware/validator');

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(overrides = {}) {
  return {
    method:  'POST',
    path:    '/events',
    headers: { 'content-type': 'application/json' },
    body:    {},
    query:   {},
    params:  {},
    ...overrides,
  };
}

function makeRes() {
  return { statusCode: null, _body: null, _sent: false };
}

// ─── escapeHtml ────────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes &', () => expect(escapeHtml('a&b')).toBe('a&amp;b'));
  it('escapes <', () => expect(escapeHtml('<div>')).toBe('&lt;div&gt;'));
  it('escapes >', () => expect(escapeHtml('a>b')).toBe('a&gt;b'));
  it('escapes "', () => expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;'));
  it("escapes '", () => expect(escapeHtml("it's")).toBe('it&#x27;s'));
  it('escapes /', () => expect(escapeHtml('a/b')).toBe('a&#x2F;b'));
  it('leaves safe strings untouched', () => expect(escapeHtml('Hello World 123')).toBe('Hello World 123'));
  it('escapes multiple characters in one string', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;',
    );
  });
});

// ─── sanitizeValue ─────────────────────────────────────────────────────────────

describe('sanitizeValue', () => {
  it('escapes strings', () => {
    expect(sanitizeValue('<b>hello</b>')).toBe('&lt;b&gt;hello&lt;&#x2F;b&gt;');
  });

  it('passes through numbers untouched', () => {
    expect(sanitizeValue(42)).toBe(42);
  });

  it('passes through booleans untouched', () => {
    expect(sanitizeValue(true)).toBe(true);
    expect(sanitizeValue(false)).toBe(false);
  });

  it('passes through null untouched', () => {
    expect(sanitizeValue(null)).toBeNull();
  });

  it('recursively sanitises arrays', () => {
    expect(sanitizeValue(['<a>', 'safe', 42])).toEqual(['&lt;a&gt;', 'safe', 42]);
  });

  it('recursively sanitises nested objects', () => {
    const result = sanitizeValue({ name: '<b>Bob</b>', age: 30 });
    expect(result.name).toBe('&lt;b&gt;Bob&lt;&#x2F;b&gt;');
    expect(result.age).toBe(30);
  });

  it('handles deeply nested structures', () => {
    const result = sanitizeValue({ outer: { inner: '<script>' } });
    expect(result.outer.inner).toBe('&lt;script&gt;');
  });
});

// ─── validateContentType ──────────────────────────────────────────────────────

describe('validateContentType', () => {
  it('calls next() for POST with application/json', () => {
    const req  = makeReq({ method: 'POST', headers: { 'content-type': 'application/json' } });
    const res  = makeRes();
    const next = jest.fn();

    validateContentType(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res._sent).toBe(false);
  });

  it('calls next() for GET (no body method — content-type irrelevant)', () => {
    const req  = makeReq({ method: 'GET', headers: {} });
    const res  = makeRes();
    const next = jest.fn();

    validateContentType(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('calls next() for DELETE (no body method)', () => {
    const req  = makeReq({ method: 'DELETE', headers: {} });
    const res  = makeRes();
    const next = jest.fn();
    validateContentType(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 415 for POST with text/plain content-type', () => {
    const req  = makeReq({ method: 'POST', headers: { 'content-type': 'text/plain' } });
    const res  = makeRes();
    const next = jest.fn();

    validateContentType(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(415);
  });

  it('returns 415 for PUT with no content-type', () => {
    const req  = makeReq({ method: 'PUT', headers: {} });
    const res  = makeRes();
    const next = jest.fn();

    validateContentType(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(415);
  });

  it('accepts content-type with charset suffix', () => {
    const req  = makeReq({ method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' } });
    const res  = makeRes();
    const next = jest.fn();

    validateContentType(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

// ─── checkBodySize ────────────────────────────────────────────────────────────

describe('checkBodySize', () => {
  it('calls next() when content-length is within the 1 MB limit', () => {
    const req  = makeReq({ headers: { 'content-length': '512' } });
    const res  = makeRes();
    const next = jest.fn();

    checkBodySize(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('calls next() when content-length header is absent', () => {
    const req  = makeReq({ headers: {} });
    const res  = makeRes();
    const next = jest.fn();

    checkBodySize(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 413 when content-length exceeds 1 MB', () => {
    const req  = makeReq({ headers: { 'content-length': String(1 * 1024 * 1024 + 1) } });
    const res  = makeRes();
    const next = jest.fn();

    checkBodySize(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(413);
  });

  it('calls next() when content-length is exactly 1 MB (boundary)', () => {
    const req  = makeReq({ headers: { 'content-length': String(1 * 1024 * 1024) } });
    const res  = makeRes();
    const next = jest.fn();

    checkBodySize(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

// ─── sanitizeInput ────────────────────────────────────────────────────────────

describe('sanitizeInput', () => {
  it('sanitises string values in req.body', () => {
    const req  = makeReq({ body: { name: '<b>test</b>', age: 25 } });
    const next = jest.fn();

    sanitizeInput(req, {}, next);

    expect(req.body.name).toBe('&lt;b&gt;test&lt;&#x2F;b&gt;');
    expect(req.body.age).toBe(25);
    expect(next).toHaveBeenCalled();
  });

  it('sanitises req.query', () => {
    const req  = makeReq({ query: { search: '<script>' } });
    const next = jest.fn();

    sanitizeInput(req, {}, next);

    expect(req.query.search).toBe('&lt;script&gt;');
  });

  it('sanitises req.params', () => {
    const req  = makeReq({ params: { id: '<id>' } });
    const next = jest.fn();

    sanitizeInput(req, {}, next);

    expect(req.params.id).toBe('&lt;id&gt;');
  });

  it('calls next() even when body is empty', () => {
    const req  = makeReq({ body: {} });
    const next = jest.fn();

    sanitizeInput(req, {}, next);

    expect(next).toHaveBeenCalled();
  });

  it('does not throw when body is null', () => {
    const req  = makeReq({ body: null });
    const next = jest.fn();

    sanitizeInput(req, {}, next);

    expect(next).toHaveBeenCalled();
  });
});

// ─── sanitize (combined array) ────────────────────────────────────────────────

describe('sanitize array', () => {
  it('exports an array of three middleware functions', () => {
    expect(Array.isArray(sanitize)).toBe(true);
    expect(sanitize).toHaveLength(3);
    sanitize.forEach((fn) => expect(typeof fn).toBe('function'));
  });
});

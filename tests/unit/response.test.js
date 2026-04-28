'use strict';

/**
 * Unit tests for src/utils/response.js
 */

const { success, error, paginated } = require('../../src/utils/response');

function makeRes() {
  const res = {
    _status: null,
    _body:   null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body;   return this; },
  };
  return res;
}

describe('success', () => {
  it('sends 200 with success:true and data by default', () => {
    const res = makeRes();
    success(res, { id: 1 });
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ success: true, data: { id: 1 } });
  });

  it('uses a custom statusCode', () => {
    const res = makeRes();
    success(res, { created: true }, 201);
    expect(res._status).toBe(201);
  });

  it('defaults data to empty object', () => {
    const res = makeRes();
    success(res);
    expect(res._body.data).toEqual({});
  });
});

describe('error', () => {
  it('sends 500 with success:false by default', () => {
    const res = makeRes();
    error(res);
    expect(res._status).toBe(500);
    expect(res._body.success).toBe(false);
    expect(res._body.message).toBe('Internal server error');
  });

  it('uses provided message and statusCode', () => {
    const res = makeRes();
    error(res, 'Not found', 404);
    expect(res._status).toBe(404);
    expect(res._body.message).toBe('Not found');
  });

  it('includes details when provided', () => {
    const res = makeRes();
    error(res, 'Bad request', 400, [{ field: 'email' }]);
    expect(res._body.details).toEqual([{ field: 'email' }]);
  });

  it('omits details when null', () => {
    const res = makeRes();
    error(res, 'Oops', 500, null);
    expect(res._body).not.toHaveProperty('details');
  });
});

describe('paginated', () => {
  it('returns 200 with pagination metadata', () => {
    const res   = makeRes();
    const items = [{ id: 1 }, { id: 2 }];
    paginated(res, items, 100, 2, 10);
    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.data).toEqual(items);
    expect(res._body.pagination).toEqual({
      total: 100,
      page:  2,
      limit: 10,
      pages: 10,
    });
  });

  it('calculates pages correctly with ceiling', () => {
    const res = makeRes();
    paginated(res, [], 11, 1, 5);
    expect(res._body.pagination.pages).toBe(3);   // ceil(11/5) = 3
  });
});

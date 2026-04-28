'use strict';

/**
 * Integration tests — Express app (api.js)
 *
 * Tests the full HTTP request/response cycle using supertest.
 * All AWS services and database calls are mocked so no infrastructure is needed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks — must be declared before any require() calls
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('../../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

// Mock DynamoDB used by rateLimiter (MetricsTable) and authService (UsersTable)
const mockDynamoSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDynamoSend })) },
  UpdateCommand: jest.fn((x) => x),
  PutCommand:    jest.fn((x) => x),
  GetCommand:    jest.fn((x) => x),
  QueryCommand:  jest.fn((x) => x),
  ScanCommand:   jest.fn((x) => x),
  DeleteCommand: jest.fn((x) => x),
}));

// Mock dynamodb service layer used by authService
jest.mock('../../src/services/dynamodb', () => ({
  query:  jest.fn(),
  scan:   jest.fn(),
  put:    jest.fn(),
  get:    jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────────────────────

process.env.JWT_SECRET             = 'api-test-secret-key-32chars-long!';
process.env.JWT_ISSUER             = 'event-monitor-system';
process.env.JWT_AUDIENCE           = 'event-monitor-api';
process.env.AWS_REGION             = 'ap-south-1';
process.env.DYNAMODB_METRICS_TABLE = 'MetricsTable-test';
process.env.DYNAMODB_USERS_TABLE   = 'UsersTable-test';
process.env.BCRYPT_SALT_ROUNDS     = '1';   // fast hashing for tests

const request     = require('supertest');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const db          = require('../../src/services/dynamodb');
const { app }     = require('../../src/handlers/api');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Rate-limiter DynamoDB call always allows (count=1, below any limit). */
function allowRateLimit() {
  mockDynamoSend.mockResolvedValueOnce({ Attributes: { count: 1 } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset mocks between tests
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Health endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok (no auth required)', async () => {
    allowRateLimit();

    const res = await request(app).get('/health');

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth endpoints — /api/v1/auth
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/register', () => {
  it('creates a user and returns 201 with safe fields', async () => {
    allowRateLimit();
    db.query.mockResolvedValueOnce({ items: [] });     // no existing user
    db.put.mockResolvedValueOnce({});                  // save new user

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'new@example.com', password: 'Password1!' });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.email).toBe('new@example.com');
    expect(res.body.data.passwordHash).toBeUndefined();
  });

  it('returns 409 when the email is already registered', async () => {
    allowRateLimit();
    db.query.mockResolvedValueOnce({
      items: [{ id: 'existing', email: 'taken@example.com' }],
    });

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'taken@example.com', password: 'Password1!' });

    expect(res.statusCode).toBe(409);
  });

  it('returns 400 when email is missing', async () => {
    allowRateLimit();

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ password: 'Password1!' });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when password is missing', async () => {
    allowRateLimit();

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'new@example.com' });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/v1/auth/login', () => {
  it('returns 200 with JWT token for valid credentials', async () => {
    allowRateLimit();
    const hash = await bcrypt.hash('Password1!', 1);
    db.query.mockResolvedValueOnce({
      items: [{ id: 'user-1', email: 'user@example.com', passwordHash: hash, role: 'viewer' }],
    });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: 'Password1!' });

    expect(res.statusCode).toBe(200);
    expect(typeof res.body.data.token).toBe('string');
    const decoded = jwt.decode(res.body.data.token);
    expect(decoded.email).toBe('user@example.com');
  });

  it('returns 401 for wrong password', async () => {
    allowRateLimit();
    const hash = await bcrypt.hash('correct', 1);
    db.query.mockResolvedValueOnce({
      items: [{ id: 'user-1', email: 'user@example.com', passwordHash: hash, role: 'viewer' }],
    });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: 'wrong' });

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when user not found', async () => {
    allowRateLimit();
    db.query.mockResolvedValueOnce({ items: [] });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'Password1!' });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns 200 with current user for a valid token', async () => {
    allowRateLimit();

    const token = jwt.sign(
      { sub: 'user-1', email: 'me@example.com', role: 'viewer' },
      process.env.JWT_SECRET,
      {
        expiresIn: '1h',
        issuer:    process.env.JWT_ISSUER,
        audience:  process.env.JWT_AUDIENCE,
      },
    );
    db.get.mockResolvedValueOnce({ id: 'user-1', email: 'me@example.com', role: 'viewer' });

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.email).toBe('me@example.com');
  });

  it('returns 401 when no Authorization header is provided', async () => {
    allowRateLimit();

    const res = await request(app).get('/api/v1/auth/me');

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for an expired or invalid token', async () => {
    allowRateLimit();

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not.a.valid.token');

    expect(res.statusCode).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 404 fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('Unknown routes', () => {
  it('returns 404 for an unknown path', async () => {
    allowRateLimit();

    const res = await request(app).get('/api/v1/does-not-exist');

    expect(res.statusCode).toBe(404);
  });
});

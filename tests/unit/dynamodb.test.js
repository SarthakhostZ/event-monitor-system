'use strict';

/**
 * Unit tests for src/services/dynamodb.js
 * Mocks the AWS SDK so no real DynamoDB is needed.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand:    jest.fn((x) => x),
  GetCommand:    jest.fn((x) => x),
  UpdateCommand: jest.fn((x) => x),
  DeleteCommand: jest.fn((x) => x),
  QueryCommand:  jest.fn((x) => x),
  ScanCommand:   jest.fn((x) => x),
}));

jest.mock('../../src/utils/logger', () => ({
  debug: jest.fn(),
  info:  jest.fn(),
  error: jest.fn(),
}));

const db = require('../../src/services/dynamodb');

const TABLE = 'TestTable';

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── put ─────────────────────────────────────────────────────────────────────

describe('put', () => {
  it('sends a PutCommand and returns the item', async () => {
    mockSend.mockResolvedValueOnce({});
    const item = { id: 'abc', name: 'test' };
    const result = await db.put(TABLE, item);
    expect(result).toEqual(item);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('propagates errors from the SDK', async () => {
    mockSend.mockRejectedValueOnce(new Error('DynamoDB error'));
    await expect(db.put(TABLE, { id: '1' })).rejects.toThrow('DynamoDB error');
  });
});

// ─── get ─────────────────────────────────────────────────────────────────────

describe('get', () => {
  it('returns the Item when found', async () => {
    mockSend.mockResolvedValueOnce({ Item: { id: 'abc', name: 'test' } });
    const result = await db.get(TABLE, { id: 'abc' });
    expect(result).toEqual({ id: 'abc', name: 'test' });
  });

  it('returns null when Item is undefined', async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await db.get(TABLE, { id: 'missing' });
    expect(result).toBeNull();
  });
});

// ─── update ──────────────────────────────────────────────────────────────────

describe('update', () => {
  it('returns the updated Attributes', async () => {
    const updated = { id: '1', status: 'active' };
    mockSend.mockResolvedValueOnce({ Attributes: updated });
    const result = await db.update(TABLE, { id: '1' }, { status: 'active' });
    expect(result).toEqual(updated);
  });

  it('builds UpdateExpression from multiple fields', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: {} });
    await db.update(TABLE, { id: '1' }, { a: 1, b: 2 });
    const calledArg = mockSend.mock.calls[0][0];
    expect(calledArg.UpdateExpression).toContain('#a = :a');
    expect(calledArg.UpdateExpression).toContain('#b = :b');
  });
});

// ─── remove ──────────────────────────────────────────────────────────────────

describe('remove', () => {
  it('sends a DeleteCommand', async () => {
    mockSend.mockResolvedValueOnce({});
    await db.remove(TABLE, { id: 'abc' });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

// ─── query ───────────────────────────────────────────────────────────────────

describe('query', () => {
  it('returns items and lastKey', async () => {
    const items = [{ id: '1' }, { id: '2' }];
    const lastKey = { id: '2' };
    mockSend.mockResolvedValueOnce({ Items: items, LastEvaluatedKey: lastKey });
    const result = await db.query(TABLE, { KeyConditionExpression: '#id = :id' });
    expect(result.items).toEqual(items);
    expect(result.lastKey).toEqual(lastKey);
  });

  it('defaults to empty array when Items is missing', async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await db.query(TABLE, {});
    expect(result.items).toEqual([]);
    expect(result.lastKey).toBeUndefined();
  });
});

// ─── scan ────────────────────────────────────────────────────────────────────

describe('scan', () => {
  it('returns items and lastKey', async () => {
    const items = [{ id: 'a' }];
    mockSend.mockResolvedValueOnce({ Items: items, LastEvaluatedKey: undefined });
    const result = await db.scan(TABLE);
    expect(result.items).toEqual(items);
  });

  it('accepts optional params', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    const result = await db.scan(TABLE, { Limit: 5 });
    expect(result.items).toEqual([]);
  });
});

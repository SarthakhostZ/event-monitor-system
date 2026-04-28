'use strict';

/**
 * Unit tests for src/models/eventModel.js
 *
 * No external dependencies — the model is pure validation + marshalling logic.
 */

const {
  validateEvent,
  validateEventUpdate,
  createEvent,
  toItem,
  fromItem,
  toDocument,
  buildUpdateExpression,
  EVENT_SOURCES,
  EVENT_TYPES,
  SEVERITIES,
  EVENT_STATUSES,
} = require('../../src/models/eventModel');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

describe('eventModel — exported constants', () => {
  it('EVENT_SOURCES contains api, webhook, manual', () => {
    expect(EVENT_SOURCES).toEqual(expect.arrayContaining(['api', 'webhook', 'manual']));
    expect(EVENT_SOURCES).toHaveLength(3);
  });

  it('EVENT_TYPES contains error, warning, info, critical', () => {
    expect(EVENT_TYPES).toEqual(expect.arrayContaining(['error', 'warning', 'info', 'critical']));
    expect(EVENT_TYPES).toHaveLength(4);
  });

  it('SEVERITIES contains low, medium, high, critical', () => {
    expect(SEVERITIES).toEqual(expect.arrayContaining(['low', 'medium', 'high', 'critical']));
    expect(SEVERITIES).toHaveLength(4);
  });

  it('EVENT_STATUSES contains all lifecycle values', () => {
    expect(EVENT_STATUSES).toEqual(
      expect.arrayContaining(['new', 'processing', 'analyzed', 'alerted']),
    );
    expect(EVENT_STATUSES).toHaveLength(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateEvent — success paths
// ─────────────────────────────────────────────────────────────────────────────

describe('validateEvent — valid inputs', () => {
  const minimal = { source: 'api', type: 'error', title: 'DB timeout' };

  it('accepts minimal valid input and applies all defaults', () => {
    const { value, error } = validateEvent(minimal);
    expect(error).toBeUndefined();
    expect(value.source).toBe('api');
    expect(value.type).toBe('error');
    expect(value.title).toBe('DB timeout');
    expect(value.severity).toBe('medium');       // default
    expect(value.status).toBe('new');            // default
    expect(value.description).toBe('');          // default
    expect(value.metadata).toEqual({});          // default
  });

  it('auto-generates a UUIDv4 eventId when not provided', () => {
    const { value } = validateEvent(minimal);
    expect(value.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('auto-generates an ISO timestamp when not provided', () => {
    const { value } = validateEvent(minimal);
    expect(() => new Date(value.timestamp)).not.toThrow();
    expect(new Date(value.timestamp).toISOString()).toBe(value.timestamp);
  });

  it('derives idempotencyKey from eventId when not supplied', () => {
    const { value } = validateEvent(minimal);
    expect(value.idempotencyKey).toBe(value.eventId);
  });

  it('preserves caller-supplied idempotencyKey', () => {
    const { value } = validateEvent({ ...minimal, idempotencyKey: 'caller-key-42' });
    expect(value.idempotencyKey).toBe('caller-key-42');
  });

  it('computes a positive integer TTL epoch', () => {
    const { value } = validateEvent(minimal);
    const nowSecs = Math.floor(Date.now() / 1000);
    expect(value.ttl).toBeGreaterThan(nowSecs);
    expect(Number.isInteger(value.ttl)).toBe(true);
  });

  it('accepts all valid source values', () => {
    for (const source of EVENT_SOURCES) {
      const { error } = validateEvent({ ...minimal, source });
      expect(error).toBeUndefined();
    }
  });

  it('accepts all valid type values', () => {
    for (const type of EVENT_TYPES) {
      const { error } = validateEvent({ ...minimal, type });
      expect(error).toBeUndefined();
    }
  });

  it('accepts all valid severity values', () => {
    for (const severity of SEVERITIES) {
      const { error } = validateEvent({ ...minimal, severity });
      expect(error).toBeUndefined();
    }
  });

  it('accepts all valid status values', () => {
    for (const status of EVENT_STATUSES) {
      const { error } = validateEvent({ ...minimal, status });
      expect(error).toBeUndefined();
    }
  });

  it('accepts a metadata object with mixed value types', () => {
    const { value, error } = validateEvent({
      ...minimal,
      metadata: { count: 80, region: 'ap-south-1', active: true },
    });
    expect(error).toBeUndefined();
    expect(value.metadata.count).toBe(80);
    expect(value.metadata.region).toBe('ap-south-1');
    expect(value.metadata.active).toBe(true);
  });

  it('accepts all optional AI fields when present', () => {
    const { value, error } = validateEvent({
      ...minimal,
      aiSummary:        'Database connection pool exhausted',
      aiSeverity:       'high',
      aiRecommendation: 'Increase pool size',
      aiRootCause:      'Traffic spike',
      aiConfidence:     85,
    });
    expect(error).toBeUndefined();
    expect(value.aiSummary).toBe('Database connection pool exhausted');
    expect(value.aiSeverity).toBe('high');
    expect(value.aiConfidence).toBe(85);
  });

  it('strips unknown fields silently', () => {
    const { value, error } = validateEvent({ ...minimal, unknownField: 'dropped' });
    expect(error).toBeUndefined();
    expect(value.unknownField).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateEvent — required field failures
// ─────────────────────────────────────────────────────────────────────────────

describe('validateEvent — missing required fields', () => {
  it('fails when source is missing', () => {
    const { error } = validateEvent({ type: 'error', title: 'Test' });
    expect(error).toBeDefined();
    expect(error.details.some(d => d.path.includes('source'))).toBe(true);
  });

  it('fails when type is missing', () => {
    const { error } = validateEvent({ source: 'api', title: 'Test' });
    expect(error).toBeDefined();
    expect(error.details.some(d => d.path.includes('type'))).toBe(true);
  });

  it('fails when title is missing', () => {
    const { error } = validateEvent({ source: 'api', type: 'error' });
    expect(error).toBeDefined();
    expect(error.details.some(d => d.path.includes('title'))).toBe(true);
  });

  it('collects all missing fields in a single error (abortEarly=false)', () => {
    const { error } = validateEvent({});
    expect(error).toBeDefined();
    expect(error.details.length).toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateEvent — invalid values
// ─────────────────────────────────────────────────────────────────────────────

describe('validateEvent — invalid field values', () => {
  const base = { source: 'api', type: 'error', title: 'Test event' };

  it('rejects an invalid source', () => {
    expect(validateEvent({ ...base, source: 'mobile' }).error).toBeDefined();
  });

  it('rejects an invalid type', () => {
    expect(validateEvent({ ...base, type: 'trace' }).error).toBeDefined();
  });

  it('rejects an invalid severity', () => {
    expect(validateEvent({ ...base, severity: 'catastrophic' }).error).toBeDefined();
  });

  it('rejects an invalid status', () => {
    expect(validateEvent({ ...base, status: 'archived' }).error).toBeDefined();
  });

  it('rejects title longer than 200 characters', () => {
    expect(validateEvent({ ...base, title: 'A'.repeat(201) }).error).toBeDefined();
  });

  it('rejects an empty title', () => {
    expect(validateEvent({ ...base, title: '' }).error).toBeDefined();
  });

  it('rejects description longer than 2000 characters', () => {
    expect(validateEvent({ ...base, description: 'X'.repeat(2001) }).error).toBeDefined();
  });

  it('accepts an empty-string description (allowed by schema)', () => {
    expect(validateEvent({ ...base, description: '' }).error).toBeUndefined();
  });

  it('rejects idempotencyKey longer than 128 characters', () => {
    expect(validateEvent({ ...base, idempotencyKey: 'k'.repeat(129) }).error).toBeDefined();
  });

  it('rejects aiConfidence below 0', () => {
    expect(validateEvent({ ...base, aiConfidence: -1 }).error).toBeDefined();
  });

  it('rejects aiConfidence above 100', () => {
    expect(validateEvent({ ...base, aiConfidence: 101 }).error).toBeDefined();
  });

  it('rejects aiSeverity with an invalid severity value', () => {
    expect(validateEvent({ ...base, aiSeverity: 'extreme' }).error).toBeDefined();
  });

  it('rejects a non-ISO timestamp', () => {
    expect(validateEvent({ ...base, timestamp: 'not-a-date' }).error).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateEventUpdate
// ─────────────────────────────────────────────────────────────────────────────

describe('validateEventUpdate', () => {
  it('accepts a single status field', () => {
    const { value, error } = validateEventUpdate({ status: 'analyzed' });
    expect(error).toBeUndefined();
    expect(value.status).toBe('analyzed');
  });

  it('accepts a full AI update payload', () => {
    const { value, error } = validateEventUpdate({
      status:           'analyzed',
      severity:         'high',
      aiSummary:        'Connection pool exhausted',
      aiSeverity:       'high',
      aiRecommendation: 'Scale up',
      aiRootCause:      'Traffic spike',
      aiConfidence:     88,
    });
    expect(error).toBeUndefined();
    expect(value.aiConfidence).toBe(88);
    expect(value.aiSeverity).toBe('high');
  });

  it('strips unknown fields silently', () => {
    const { value, error } = validateEventUpdate({ status: 'analyzed', extra: 'ignored' });
    expect(error).toBeUndefined();
    expect(value.extra).toBeUndefined();
  });

  it('fails when no fields are supplied (min(1) constraint)', () => {
    const { error } = validateEventUpdate({});
    expect(error).toBeDefined();
  });

  it('rejects an invalid status string', () => {
    expect(validateEventUpdate({ status: 'deleted' }).error).toBeDefined();
  });

  it('rejects aiConfidence outside 0–100', () => {
    expect(validateEventUpdate({ aiConfidence: 150 }).error).toBeDefined();
    expect(validateEventUpdate({ aiConfidence: -10 }).error).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createEvent (factory)
// ─────────────────────────────────────────────────────────────────────────────

describe('createEvent', () => {
  it('returns a complete event with all defaults applied', () => {
    const event = createEvent({ source: 'api', type: 'error', title: 'Factory test' });
    expect(event.severity).toBe('medium');
    expect(event.status).toBe('new');
    expect(event.description).toBe('');
    expect(typeof event.eventId).toBe('string');
    expect(typeof event.ttl).toBe('number');
  });

  it('preserves caller-supplied overrides', () => {
    const event = createEvent({
      source:   'webhook',
      type:     'critical',
      title:    'Payment gateway down',
      severity: 'critical',
    });
    expect(event.source).toBe('webhook');
    expect(event.type).toBe('critical');
    expect(event.severity).toBe('critical');
  });

  it('generates unique eventIds on each call', () => {
    const a = createEvent({ source: 'api', type: 'info', title: 'A' });
    const b = createEvent({ source: 'api', type: 'info', title: 'B' });
    expect(a.eventId).not.toBe(b.eventId);
  });

  it('throws a descriptive Error when validation fails', () => {
    expect(() => createEvent({ source: 'api', type: 'error' /* missing title */ }))
      .toThrow(/Event validation failed/);
  });

  it('throw message contains the invalid field name', () => {
    let message = '';
    try { createEvent({ source: 'api' }); } catch (err) { message = err.message; }
    expect(message).toContain('title');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DynamoDB marshalling — toItem / fromItem
// ─────────────────────────────────────────────────────────────────────────────

describe('toItem / fromItem round-trip', () => {
  it('marshals an event to DynamoDB low-level format', () => {
    const event = createEvent({ source: 'api', type: 'error', title: 'Marshal test' });
    const item  = toItem(event);
    // Low-level DynamoDB format wraps values in type descriptors
    expect(item.source).toHaveProperty('S', 'api');
    expect(item.type).toHaveProperty('S', 'error');
  });

  it('round-trips without data loss for all core fields', () => {
    const original = createEvent({ source: 'manual', type: 'warning', title: 'Round-trip' });
    const result   = fromItem(toItem(original));
    expect(result.eventId).toBe(original.eventId);
    expect(result.source).toBe(original.source);
    expect(result.type).toBe(original.type);
    expect(result.title).toBe(original.title);
    expect(result.severity).toBe(original.severity);
    expect(result.status).toBe(original.status);
    expect(result.ttl).toBe(original.ttl);
  });

  it('fromItem returns null for a null argument', () => {
    expect(fromItem(null)).toBeNull();
  });

  it('fromItem returns null for undefined', () => {
    expect(fromItem(undefined)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toDocument
// ─────────────────────────────────────────────────────────────────────────────

describe('toDocument', () => {
  it('strips keys with undefined values', () => {
    const event = createEvent({ source: 'api', type: 'info', title: 'Doc test' });
    event.aiSummary = undefined;
    const doc = toDocument(event);
    expect('aiSummary' in doc).toBe(false);
  });

  it('keeps keys with null values (only strips undefined)', () => {
    const event = createEvent({ source: 'api', type: 'info', title: 'Null test' });
    event.aiRootCause = null;
    const doc = toDocument(event);
    expect(doc.aiRootCause).toBeNull();
  });

  it('preserves all defined fields intact', () => {
    const event = createEvent({ source: 'webhook', type: 'error', title: 'Kept fields' });
    const doc   = toDocument(event);
    expect(doc.source).toBe('webhook');
    expect(doc.title).toBe('Kept fields');
    expect(doc.severity).toBe('medium');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildUpdateExpression
// ─────────────────────────────────────────────────────────────────────────────

describe('buildUpdateExpression', () => {
  it('builds a valid SET expression for a single field', () => {
    const { UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues }
      = buildUpdateExpression({ status: 'analyzed' });

    expect(UpdateExpression).toBe('SET #status = :status');
    expect(ExpressionAttributeNames['#status']).toBe('status');
    expect(ExpressionAttributeValues[':status']).toBe('analyzed');
  });

  it('builds a SET expression with multiple fields', () => {
    const result = buildUpdateExpression({ status: 'analyzed', aiSeverity: 'high', aiConfidence: 90 });

    expect(result.UpdateExpression).toContain('#status = :status');
    expect(result.UpdateExpression).toContain('#aiSeverity = :aiSeverity');
    expect(result.UpdateExpression).toContain('#aiConfidence = :aiConfidence');

    expect(result.ExpressionAttributeNames['#aiSeverity']).toBe('aiSeverity');
    expect(result.ExpressionAttributeValues[':aiConfidence']).toBe(90);
  });

  it('produces one name alias and one value placeholder per field', () => {
    const updates = { a: 1, b: 2, c: 3 };
    const result  = buildUpdateExpression(updates);
    expect(Object.keys(result.ExpressionAttributeNames)).toHaveLength(3);
    expect(Object.keys(result.ExpressionAttributeValues)).toHaveLength(3);
  });

  it('uses # prefix for names and : prefix for values', () => {
    const result = buildUpdateExpression({ myField: 'value' });
    expect(result.ExpressionAttributeNames).toHaveProperty('#myField');
    expect(result.ExpressionAttributeValues).toHaveProperty(':myField');
  });
});

'use strict';

/**
 * Unit tests for models/Alert.js and models/alertModel.js
 */

// ─── Alert.js (simple Joi schema) ────────────────────────────────────────────

describe('Alert.js validate()', () => {
  const { validate } = require('../../src/models/Alert');

  const validAlert = {
    id:        '550e8400-e29b-41d4-a716-446655440000',
    eventId:   '550e8400-e29b-41d4-a716-446655440001',
    severity:  'high',
    message:   'Something critical happened',
    status:    'open',
    createdAt: new Date().toISOString(),
  };

  it('accepts a fully valid alert', () => {
    const { error } = validate(validAlert);
    expect(error).toBeUndefined();
  });

  it('applies default status of "open"', () => {
    const { value } = validate({ ...validAlert, status: undefined });
    expect(value.status).toBe('open');
  });

  it('rejects missing id', () => {
    const { error } = validate({ ...validAlert, id: undefined });
    expect(error).toBeDefined();
  });

  it('rejects missing eventId', () => {
    const { error } = validate({ ...validAlert, eventId: undefined });
    expect(error).toBeDefined();
  });

  it('rejects invalid severity', () => {
    const { error } = validate({ ...validAlert, severity: 'extreme' });
    expect(error).toBeDefined();
  });

  it('rejects invalid status', () => {
    const { error } = validate({ ...validAlert, status: 'pending' });
    expect(error).toBeDefined();
  });

  it('rejects missing message', () => {
    const { error } = validate({ ...validAlert, message: undefined });
    expect(error).toBeDefined();
  });

  it('rejects missing createdAt', () => {
    const { error } = validate({ ...validAlert, createdAt: undefined });
    expect(error).toBeDefined();
  });

  it('accepts optional notifiedAt and resolvedAt', () => {
    const { error } = validate({ ...validAlert, notifiedAt: new Date().toISOString(), resolvedAt: new Date().toISOString() });
    expect(error).toBeUndefined();
  });
});

// ─── alertModel.js (createAlertSchema) ───────────────────────────────────────

describe('alertModel createAlertSchema', () => {
  const { createAlertSchema } = require('../../src/models/alertModel');

  const validData = {
    eventId: '550e8400-e29b-41d4-a716-446655440001',
    channel: 'email',
  };

  it('accepts minimal valid data with defaults', () => {
    const { error, value } = createAlertSchema.validate(validData);
    expect(error).toBeUndefined();
    expect(value.status).toBe('pending');
    expect(value.retryCount).toBe(0);
    expect(typeof value.alertId).toBe('string');
  });

  it('rejects missing eventId', () => {
    const { error } = createAlertSchema.validate({ channel: 'email' });
    expect(error).toBeDefined();
  });

  it('rejects invalid channel', () => {
    const { error } = createAlertSchema.validate({ ...validData, channel: 'telegram' });
    expect(error).toBeDefined();
  });

  it('rejects retryCount above max', () => {
    const { error } = createAlertSchema.validate({ ...validData, retryCount: 10 });
    expect(error).toBeDefined();
  });

  it('accepts all valid channels', () => {
    for (const channel of ['email', 'slack', 'sms']) {
      const { error } = createAlertSchema.validate({ ...validData, channel });
      expect(error).toBeUndefined();
    }
  });
});

'use strict';

/**
 * Unit tests for src/services/alertService.js
 */

jest.mock('../../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock AWS SNS client
const mockSnsSend = jest.fn();
jest.mock('@aws-sdk/client-sns', () => ({
  SNSClient:      jest.fn(() => ({ send: mockSnsSend })),
  PublishCommand: jest.fn((x) => x),
}));

// Mock the db layer
jest.mock('../../src/services/dynamodb', () => ({
  put:    jest.fn(),
  update: jest.fn(),
  scan:   jest.fn(),
}));

// Mock emailService
jest.mock('../../src/services/emailService', () => ({
  sendAlert: jest.fn(),
}));

// Set required env vars before config loads
process.env.AWS_REGION             = 'us-east-1';
process.env.DYNAMODB_ALERTS_TABLE  = 'AlertsTable-test';
process.env.JWT_SECRET             = 'test-secret-32chars-long-enough!!';

const alertService = require('../../src/services/alertService');
const db           = require('../../src/services/dynamodb');
const emailService = require('../../src/services/emailService');

beforeEach(() => jest.clearAllMocks());

// ─── createAlert ─────────────────────────────────────────────────────────────

describe('createAlert', () => {
  it('persists and returns a new alert object', async () => {
    db.put.mockResolvedValueOnce({});
    const alert = await alertService.createAlert({
      eventId:  'event-123',
      severity: 'high',
      message:  'Something is wrong',
    });

    expect(db.put).toHaveBeenCalledTimes(1);
    expect(alert.eventId).toBe('event-123');
    expect(alert.severity).toBe('high');
    expect(alert.message).toBe('Something is wrong');
    expect(alert.status).toBe('open');
    expect(typeof alert.id).toBe('string');
    expect(typeof alert.createdAt).toBe('string');
  });

  it('propagates db errors', async () => {
    db.put.mockRejectedValueOnce(new Error('Write failed'));
    await expect(alertService.createAlert({ eventId: 'e1', severity: 'low', message: 'm' }))
      .rejects.toThrow('Write failed');
  });
});

// ─── publishAlert ────────────────────────────────────────────────────────────

describe('publishAlert', () => {
  const alert = {
    id:        'alert-1',
    eventId:   'event-1',
    severity:  'critical',
    message:   'Critical issue',
    createdAt: new Date().toISOString(),
  };

  it('publishes to SNS when topicArn is configured', async () => {
    // Temporarily set SNS_TOPIC_ARN via the config module indirectly
    const config = require('../../src/config');
    const origArn = config.sns.topicArn;
    config.sns.topicArn = 'arn:aws:sns:us-east-1:123456:test-topic';

    mockSnsSend.mockResolvedValueOnce({});
    emailService.sendAlert.mockResolvedValueOnce({});

    await alertService.publishAlert(alert);
    expect(mockSnsSend).toHaveBeenCalledTimes(1);

    config.sns.topicArn = origArn;
  });

  it('does not throw if SNS topicArn is absent', async () => {
    const config = require('../../src/config');
    const origArn = config.sns.topicArn;
    const origEmail = config.email.alertTo;
    config.sns.topicArn = null;
    config.email.alertTo = null;

    await expect(alertService.publishAlert(alert)).resolves.not.toThrow();
    expect(mockSnsSend).not.toHaveBeenCalled();

    config.sns.topicArn  = origArn;
    config.email.alertTo = origEmail;
  });
});

// ─── acknowledgeAlert ────────────────────────────────────────────────────────

describe('acknowledgeAlert', () => {
  it('calls db.update with acknowledged status', async () => {
    db.update.mockResolvedValueOnce({ id: 'alert-1', status: 'acknowledged' });
    const result = await alertService.acknowledgeAlert('alert-1');
    expect(db.update).toHaveBeenCalledTimes(1);
    const [, key, updates] = db.update.mock.calls[0];
    expect(key).toEqual({ id: 'alert-1' });
    expect(updates.status).toBe('acknowledged');
    expect(result.status).toBe('acknowledged');
  });
});

// ─── resolveAlert ────────────────────────────────────────────────────────────

describe('resolveAlert', () => {
  it('calls db.update with resolved status', async () => {
    db.update.mockResolvedValueOnce({ id: 'alert-1', status: 'resolved' });
    const result = await alertService.resolveAlert('alert-1');
    const [, key, updates] = db.update.mock.calls[0];
    expect(key).toEqual({ id: 'alert-1' });
    expect(updates.status).toBe('resolved');
    expect(typeof updates.resolvedAt).toBe('string');
    expect(result.status).toBe('resolved');
  });
});

// ─── listAlerts ──────────────────────────────────────────────────────────────

describe('listAlerts', () => {
  it('returns all items when no status filter is given', async () => {
    db.scan.mockResolvedValueOnce({ items: [{ id: '1' }, { id: '2' }] });
    const result = await alertService.listAlerts();
    expect(result).toHaveLength(2);
    const [, params] = db.scan.mock.calls[0];
    expect(params.FilterExpression).toBeUndefined();
  });

  it('applies FilterExpression when status is provided', async () => {
    db.scan.mockResolvedValueOnce({ items: [{ id: '1', status: 'open' }] });
    const result = await alertService.listAlerts({ status: 'open' });
    expect(result).toHaveLength(1);
    const [, params] = db.scan.mock.calls[0];
    expect(params.FilterExpression).toContain('status');
  });

  it('uses custom limit', async () => {
    db.scan.mockResolvedValueOnce({ items: [] });
    await alertService.listAlerts({ limit: 5 });
    const [, params] = db.scan.mock.calls[0];
    expect(params.Limit).toBe(5);
  });
});

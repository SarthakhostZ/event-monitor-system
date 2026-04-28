'use strict';

/**
 * Unit tests for thin Lambda handlers:
 *   - handlers/health.js
 *   - handlers/alerts.js
 *   - handlers/events.js
 */

// ─── health.js ────────────────────────────────────────────────────────────────

jest.mock('../../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockDynamoSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient:      jest.fn(() => ({ send: mockDynamoSend })),
  ListTablesCommand:   jest.fn((x) => x),
}));

jest.mock('../../src/services/eventService', () => ({
  createEvent: jest.fn(),
}));

jest.mock('../../src/services/alertService', () => ({
  createAlert:  jest.fn(),
  publishAlert: jest.fn(),
}));

const health     = require('../../src/handlers/health');
const alertsHnd  = require('../../src/handlers/alerts');
const eventsHnd  = require('../../src/handlers/events');
const eventService = require('../../src/services/eventService');
const alertService = require('../../src/services/alertService');

beforeEach(() => jest.clearAllMocks());

// ─── health.check ─────────────────────────────────────────────────────────────

describe('health.check', () => {
  it('returns 200 when DynamoDB is reachable', async () => {
    mockDynamoSend.mockResolvedValueOnce({ TableNames: [] });
    const result = await health.check();
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.status).toBe('healthy');
  });

  it('returns 503 when DynamoDB is unreachable', async () => {
    mockDynamoSend.mockRejectedValueOnce(new Error('Network timeout'));
    const result = await health.check();
    expect(result.statusCode).toBe(503);
    const body = JSON.parse(result.body);
    expect(body.status).toBe('unhealthy');
    expect(body.error).toBe('Network timeout');
  });
});

// ─── alerts.process ──────────────────────────────────────────────────────────

describe('alerts.process', () => {
  it('processes SNS records without throwing', async () => {
    const event = {
      Records: [
        { Sns: { Message: JSON.stringify({ id: 'alert-1', severity: 'high', message: 'Test' }) } },
      ],
    };
    await expect(alertsHnd.process(event)).resolves.toBeUndefined();
  });

  it('handles critical severity record', async () => {
    const logger = require('../../src/utils/logger');
    const event = {
      Records: [
        { Sns: { Message: JSON.stringify({ id: 'alert-2', severity: 'critical', message: 'Critical!' }) } },
      ],
    };
    await alertsHnd.process(event);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Critical alert'));
  });

  it('catches and logs errors for malformed records', async () => {
    const logger = require('../../src/utils/logger');
    const event = {
      Records: [
        { Sns: { Message: 'not-valid-json' } },
      ],
    };
    await alertsHnd.process(event);
    expect(logger.error).toHaveBeenCalled();
  });
});

// ─── events.ingest ───────────────────────────────────────────────────────────

describe('events.ingest', () => {
  it('ingests records and calls createEvent for each', async () => {
    const created = { id: 'ev-1', severity: 'low', source: 'api' };
    eventService.createEvent.mockResolvedValueOnce(created);

    const event = {
      Records: [
        { body: JSON.stringify({ source: 'api', type: 'info', severity: 'low', title: 'Test' }) },
      ],
    };
    await eventsHnd.ingest(event);
    expect(eventService.createEvent).toHaveBeenCalledTimes(1);
  });

  it('creates and publishes alert for high severity events', async () => {
    const created = { id: 'ev-2', severity: 'high', source: 'api' };
    eventService.createEvent.mockResolvedValueOnce(created);
    alertService.createAlert.mockResolvedValueOnce({ id: 'al-1' });
    alertService.publishAlert.mockResolvedValueOnce({});

    const event = {
      Records: [
        { body: JSON.stringify({ source: 'api', type: 'error', severity: 'high', title: 'High severity' }) },
      ],
    };
    await eventsHnd.ingest(event);
    expect(alertService.createAlert).toHaveBeenCalledTimes(1);
    expect(alertService.publishAlert).toHaveBeenCalledTimes(1);
  });

  it('creates alert for critical severity', async () => {
    const created = { id: 'ev-3', severity: 'critical', source: 'webhook' };
    eventService.createEvent.mockResolvedValueOnce(created);
    alertService.createAlert.mockResolvedValueOnce({ id: 'al-2' });
    alertService.publishAlert.mockResolvedValueOnce({});

    const event = {
      Records: [
        { body: JSON.stringify({ source: 'webhook', type: 'critical', severity: 'critical', title: 'Critical' }) },
      ],
    };
    await eventsHnd.ingest(event);
    expect(alertService.createAlert).toHaveBeenCalledTimes(1);
  });

  it('logs error count when records fail', async () => {
    const logger = require('../../src/utils/logger');
    eventService.createEvent.mockRejectedValueOnce(new Error('DB error'));

    const event = {
      Records: [
        { body: JSON.stringify({ source: 'api', type: 'info', severity: 'low', title: 'Test' }) },
      ],
    };
    await eventsHnd.ingest(event);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('1 records failed'));
  });
});
